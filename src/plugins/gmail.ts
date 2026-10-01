import { z } from "zod";
import { isPekkaCallback } from "../auth.ts";
import { ensureSchema, getDatabase, type Database } from "../database/database.ts";
import { seal, unseal } from "./secrets.ts";

// The user's own Gmail through Google OAuth. gmail.modify covers reading,
// labelling, drafting and sending, but not permanent deletion.
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const LABEL = "pekka:gmail:v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

const Credentials = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_at: z.number() });
type Tokens = z.infer<typeof Credentials>;
type Connection = { credentials: string; workspace_name: string; enabled: number };
const Grant = z.object({ access_token: z.string().min(1), expires_in: z.number(), refresh_token: z.string().min(1).optional(), scope: z.string().default("") });

export class GmailError extends Error {}

export class GmailService {
  private readonly databaseFor: () => Database;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: { database?: () => Database; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
    this.databaseFor = options.database ?? getDatabase;
    this.env = options.env ?? process.env;
    this.fetcher = options.fetch ?? fetch;
  }

  private config() {
    const clientId = this.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = this.env.GOOGLE_CLIENT_SECRET?.trim();
    const redirectUri = this.env.GOOGLE_REDIRECT_URI?.trim();
    const key = this.env.PEKKA_PLUGIN_KEY?.trim();
    if (!clientId || !clientSecret || !redirectUri || !key || !/^[a-f\d]{64}$/i.test(key)) {
      throw new GmailError("Gmail needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and a 64-character hex PEKKA_PLUGIN_KEY. See .env.example.");
    }
    if (!isPekkaCallback(redirectUri, "/api/plugins/gmail/callback", this.env)) {
      throw new GmailError("Google redirect must be Pekka's /api/plugins/gmail/callback URL, on localhost or at PEKKA_URL.");
    }
    return { clientId, clientSecret, redirectUri, key: Buffer.from(key, "hex") };
  }

  /** Serializes token changes so concurrent tool calls never race a refresh. */
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  private async database() {
    const database = this.databaseFor();
    await ensureSchema(database);
    return database;
  }

  private async connection(database: Database, userId: string): Promise<Connection | undefined> {
    const [row] = await database.query<Connection>("SELECT credentials, workspace_name, enabled FROM plugin_accounts WHERE user_id = ? AND plugin = ?", [userId, "gmail"]);
    return row;
  }

  async status(userId: string) {
    const base = { id: "gmail", name: "Gmail", configured: false, connected: false, enabled: false, workspaceName: "" };
    try { this.config(); } catch { return base; }
    const row = await this.connection(await this.database(), userId);
    return { ...base, configured: true, connected: !!row, enabled: Number(row?.enabled) === 1, workspaceName: row?.workspace_name ?? "" };
  }

  authorize(state: string): string {
    const config = this.config();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    // prompt=consent makes Google return a refresh token on every connect, not only the first.
    url.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: SCOPE,
      access_type: "offline", prompt: "consent", state,
    }).toString();
    return url.href;
  }

  private encrypt(tokens: Tokens): string {
    return seal(this.config().key, LABEL, JSON.stringify(tokens));
  }

  private decrypt(value: string): Tokens {
    try { return Credentials.parse(JSON.parse(unseal(this.config().key, LABEL, value))); }
    catch { throw new GmailError("Cannot unlock the Gmail connection. Restore PEKKA_PLUGIN_KEY or reconnect Gmail."); }
  }

  private async send(url: string, init: RequestInit) {
    try {
      return await this.fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000), ...init });
    } catch {
      throw new GmailError("Could not reach Google. A send or change may have completed; check Gmail before retrying.");
    }
  }

  private async token(form: Record<string, string>) {
    const config = this.config();
    const response = await this.send(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...form }),
    });
    if (!response.ok) {
      const { error } = z.object({ error: z.string().optional() }).catch({}).parse(await response.json().catch(() => null));
      if (error === "invalid_grant") throw new GmailError("Google rejected the saved Gmail connection; it may have been revoked or expired. Reconnect Gmail in Plugins.");
      throw new GmailError(`Google sign-in failed (HTTP ${response.status}${error ? ` ${error}` : ""}). Check the Google OAuth setup.`);
    }
    const grant = Grant.safeParse(await response.json().catch(() => null));
    if (!grant.success) throw new GmailError("Google returned an invalid sign-in response. Please reconnect.");
    return grant.data;
  }

  exchange(userId: string, code: string): Promise<void> {
    return this.serial(async () => {
      const database = await this.database();
      const grant = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.config().redirectUri });
      // Google's consent screen lets people untick individual permissions.
      if (!grant.scope.split(" ").includes(SCOPE)) throw new GmailError("Gmail access was not granted on Google's consent screen.");
      if (!grant.refresh_token) throw new GmailError("Google did not return a refresh token. Reconnect Gmail.");
      const profile = await this.api(`${API}/profile`, { method: "GET" }, grant.access_token);
      const email = z.object({ emailAddress: z.string() }).safeParse(await profile.json().catch(() => null));
      const tokens = { access_token: grant.access_token, refresh_token: grant.refresh_token, expires_at: Date.now() + grant.expires_in * 1000 };
      await database.run(
        "INSERT INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled) VALUES (?, ?, ?, ?, 0) ON CONFLICT(user_id, plugin) DO UPDATE SET credentials = excluded.credentials, workspace_name = excluded.workspace_name, enabled = 0",
        [userId, "gmail", this.encrypt(tokens), email.success ? email.data.emailAddress : "Gmail account"],
      );
    });
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    const database = await this.database();
    if (enabled) {
      this.config();
      const row = await this.connection(database, userId);
      if (!row) throw new GmailError("Connect Gmail before allowing access.");
      this.decrypt(row.credentials);
    }
    await database.run("UPDATE plugin_accounts SET enabled = ? WHERE user_id = ? AND plugin = ?", [enabled ? 1 : 0, userId, "gmail"]);
  }

  async disconnect(userId: string): Promise<void> {
    await this.setEnabled(userId, false);
    return this.serial(async () => {
      const database = await this.database();
      const row = await this.connection(database, userId);
      if (!row) return;
      const tokens = this.decrypt(row.credentials);
      // Revoking the refresh token also revokes every access token issued from it.
      const response = await this.send("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refresh_token }),
      });
      // invalid_token means Google already dropped it (e.g. removed in the Google account), so deleting our copy is safe.
      const gone = response.status === 400 && (await response.json().catch(() => null))?.error === "invalid_token";
      if (!response.ok && !gone) throw new GmailError("Gmail access is disabled, but revocation failed. Retry Disconnect or remove Pekka at myaccount.google.com/permissions.");
      await database.run("DELETE FROM plugin_accounts WHERE user_id = ? AND plugin = ? AND credentials = ?", [userId, "gmail", row.credentials]);
    });
  }

  private async enabledConnection(database: Database, userId: string): Promise<Connection> {
    const row = await this.connection(database, userId);
    if (!row || Number(row.enabled) !== 1) throw new GmailError("Gmail access is off. Connect Gmail and allow Pekka access in Plugins.");
    return row;
  }

  /** A usable access token, refreshed when it is about to expire or `stale` was rejected. */
  private accessToken(userId: string, stale?: string): Promise<string> {
    return this.serial(async () => {
      this.config();
      const database = await this.database();
      const row = await this.enabledConnection(database, userId);
      const tokens = this.decrypt(row.credentials);
      if (tokens.access_token !== stale && tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
      const grant = await this.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      const refreshed = { access_token: grant.access_token, refresh_token: grant.refresh_token ?? tokens.refresh_token, expires_at: Date.now() + grant.expires_in * 1000 };
      const update = await database.run("UPDATE plugin_accounts SET credentials = ? WHERE user_id = ? AND plugin = ? AND credentials = ?", [this.encrypt(refreshed), userId, "gmail", row.credentials]);
      if (!update.changes) throw new GmailError("Gmail connection changed during the request. Try again if access is still enabled.");
      await this.enabledConnection(database, userId);
      return refreshed.access_token;
    });
  }

  private api(url: string, init: RequestInit, accessToken: string) {
    return this.send(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } });
  }

  /** Calls the Gmail API for `userId`'s connected account. `path` is relative to /users/me. */
  async request(userId: string, path: string, method: "GET" | "POST", data?: unknown): Promise<unknown> {
    if (!/^\/(?:profile|labels|messages(?:\/send|\/[\w-]+(?:\/modify)?)?|threads\/[\w-]+|drafts)(?:\?[^#]*)?$/.test(path)) {
      throw new GmailError("Unsupported Gmail operation.");
    }
    const init = { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) };
    let token = await this.accessToken(userId);
    let response = await this.api(`${API}${path}`, init, token);
    if (response.status === 401) {
      token = await this.accessToken(userId, token);
      response = await this.api(`${API}${path}`, init, token);
    }
    if (!response.ok) {
      const body = z.object({ error: z.object({ message: z.string().optional(), status: z.string().optional() }) }).safeParse(await response.json().catch(() => null));
      const detail = body.success ? [body.data.error.status, body.data.error.message?.slice(0, 500)].filter(Boolean).join(": ") : "";
      throw new GmailError(`Gmail request failed (HTTP ${response.status}${detail ? ` ${detail}` : ""}).`);
    }
    try { return await response.json(); } catch { throw new GmailError("Gmail returned an unreadable response. Check Gmail before retrying a send."); }
  }
}

let defaultService: GmailService | undefined;
export function getGmailService(): GmailService {
  return defaultService ??= new GmailService();
}
