import { z } from "zod";
import { isPekkaCallback } from "../auth.ts";
import { ensureSchema, getDatabase, type Database } from "../database/database.ts";
import { seal, unseal } from "./secrets.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const Credentials = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_at: z.number() });
type Tokens = z.infer<typeof Credentials>;
type Connection = { credentials: string; workspace_name: string; enabled: number };
const Grant = z.object({ access_token: z.string().min(1), expires_in: z.number(), refresh_token: z.string().min(1).optional(), scope: z.string().default("") });

export type GoogleMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Every Google plugin's errors extend this, so the API reports them as bad requests. */
export class GoogleError extends Error {}

export interface GoogleOptions { database?: () => Database; env?: NodeJS.ProcessEnv; fetch?: typeof fetch }

/** What sets one Google plugin apart from another. */
export interface GoogleProduct {
  /** Plugin id: the D1 key and the /api/plugins/<id> route. */
  id: string;
  name: string;
  scopes: string[];
  error: new (message: string) => GoogleError;
}

/**
 * A plugin that signs in to the user's own Google account. Each plugin keeps
 * its own connection and access switch. They share one OAuth client, and
 * GOOGLE_REDIRECT_URI (Gmail's callback) sets the host every callback uses.
 */
export abstract class GoogleService {
  private readonly product: GoogleProduct;
  private readonly databaseFor: () => Database;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(product: GoogleProduct, options: GoogleOptions = {}) {
    this.product = product;
    this.databaseFor = options.database ?? getDatabase;
    this.env = options.env ?? process.env;
    this.fetcher = options.fetch ?? fetch;
  }

  /** The full URL for an allowed API call, or undefined to refuse it. */
  protected abstract endpoint(path: string, method: GoogleMethod): string | undefined;

  /** The connected account's display name, looked up during connection. */
  protected abstract accountName(accessToken: string): Promise<string>;

  private fail(message: string): GoogleError {
    return new this.product.error(message);
  }

  private config() {
    const { id, name } = this.product;
    const clientId = this.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = this.env.GOOGLE_CLIENT_SECRET?.trim();
    const gmailRedirect = this.env.GOOGLE_REDIRECT_URI?.trim();
    const key = this.env.PEKKA_PLUGIN_KEY?.trim();
    if (!clientId || !clientSecret || !gmailRedirect || !key || !/^[a-f\d]{64}$/i.test(key)) {
      throw this.fail(`${name} needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and a 64-character hex PEKKA_PLUGIN_KEY. See .env.example.`);
    }
    if (!isPekkaCallback(gmailRedirect, "/api/plugins/gmail/callback", this.env)) {
      throw this.fail("GOOGLE_REDIRECT_URI must be Pekka's /api/plugins/gmail/callback URL, on localhost or at PEKKA_URL. Other Google plugins use the same host.");
    }
    return { clientId, clientSecret, redirectUri: new URL(`/api/plugins/${id}/callback`, gmailRedirect).href, key: Buffer.from(key, "hex") };
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
    const [row] = await database.query<Connection>("SELECT credentials, workspace_name, enabled FROM plugin_accounts WHERE user_id = ? AND plugin = ?", [userId, this.product.id]);
    return row;
  }

  async status(userId: string) {
    const base = { id: this.product.id, name: this.product.name, configured: false, connected: false, enabled: false, workspaceName: "" };
    try { this.config(); } catch { return base; }
    const row = await this.connection(await this.database(), userId);
    return { ...base, configured: true, connected: !!row, enabled: Number(row?.enabled) === 1, workspaceName: row?.workspace_name ?? "" };
  }

  authorize(state: string): string {
    const config = this.config();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    // prompt=consent makes Google return a refresh token on every connect, not only the first.
    url.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: this.product.scopes.join(" "),
      access_type: "offline", prompt: "consent", state,
    }).toString();
    return url.href;
  }

  private encrypt(tokens: Tokens): string {
    return seal(this.config().key, `pekka:${this.product.id}:v1`, JSON.stringify(tokens));
  }

  private decrypt(value: string): Tokens {
    try { return Credentials.parse(JSON.parse(unseal(this.config().key, `pekka:${this.product.id}:v1`, value))); }
    catch { throw this.fail(`Cannot unlock the ${this.product.name} connection. Restore PEKKA_PLUGIN_KEY or reconnect ${this.product.name}.`); }
  }

  private async send(url: string, init: RequestInit) {
    try {
      return await this.fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000), ...init });
    } catch {
      throw this.fail(`Could not reach Google. A send or change may have completed; check ${this.product.name} before retrying.`);
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
      if (error === "invalid_grant") throw this.fail(`Google rejected the saved ${this.product.name} connection; it may have been revoked or expired. Reconnect ${this.product.name} in Plugins.`);
      throw this.fail(`Google sign-in failed (HTTP ${response.status}${error ? ` ${error}` : ""}). Check the Google OAuth setup.`);
    }
    const grant = Grant.safeParse(await response.json().catch(() => null));
    if (!grant.success) throw this.fail("Google returned an invalid sign-in response. Please reconnect.");
    return grant.data;
  }

  exchange(userId: string, code: string): Promise<void> {
    return this.serial(async () => {
      const { id, name, scopes } = this.product;
      const database = await this.database();
      const grant = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.config().redirectUri });
      // Google's consent screen lets people untick individual permissions.
      const granted = grant.scope.split(" ");
      if (!scopes.every((scope) => granted.includes(scope))) throw this.fail(`${name} access was not granted on Google's consent screen.`);
      if (!grant.refresh_token) throw this.fail(`Google did not return a refresh token. Reconnect ${name}.`);
      const account = await this.accountName(grant.access_token);
      const tokens = { access_token: grant.access_token, refresh_token: grant.refresh_token, expires_at: Date.now() + grant.expires_in * 1000 };
      await database.run(
        "INSERT INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled) VALUES (?, ?, ?, ?, 0) ON CONFLICT(user_id, plugin) DO UPDATE SET credentials = excluded.credentials, workspace_name = excluded.workspace_name, enabled = 0",
        [userId, id, this.encrypt(tokens), account || `${name} account`],
      );
    });
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    const database = await this.database();
    if (enabled) {
      this.config();
      const row = await this.connection(database, userId);
      if (!row) throw this.fail(`Connect ${this.product.name} before allowing access.`);
      this.decrypt(row.credentials);
    }
    await database.run("UPDATE plugin_accounts SET enabled = ? WHERE user_id = ? AND plugin = ?", [enabled ? 1 : 0, userId, this.product.id]);
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
      if (!response.ok && !gone) throw this.fail(`${this.product.name} access is disabled, but revocation failed. Retry Disconnect or remove Pekka at myaccount.google.com/permissions.`);
      await database.run("DELETE FROM plugin_accounts WHERE user_id = ? AND plugin = ? AND credentials = ?", [userId, this.product.id, row.credentials]);
    });
  }

  private async enabledConnection(database: Database, userId: string): Promise<Connection> {
    const row = await this.connection(database, userId);
    if (!row || Number(row.enabled) !== 1) throw this.fail(`${this.product.name} access is off. Connect ${this.product.name} and allow Pekka access in Plugins.`);
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
      const update = await database.run("UPDATE plugin_accounts SET credentials = ? WHERE user_id = ? AND plugin = ? AND credentials = ?", [this.encrypt(refreshed), userId, this.product.id, row.credentials]);
      if (!update.changes) throw this.fail(`${this.product.name} connection changed during the request. Try again if access is still enabled.`);
      await this.enabledConnection(database, userId);
      return refreshed.access_token;
    });
  }

  protected api(url: string, init: RequestInit, accessToken: string) {
    return this.send(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } });
  }

  /** Calls an allowed Google API path for `userId`'s connected account. */
  private async call(userId: string, path: string, method: GoogleMethod, data?: unknown): Promise<Response> {
    const { name } = this.product;
    const url = this.endpoint(path, method);
    // URL parsing resolves "." and ".." segments, so an id like ".." must not walk to another endpoint.
    const target = url === undefined ? undefined : new URL(url);
    if (!url || !target || !url.startsWith(target.origin + target.pathname)) throw this.fail(`Unsupported ${name} operation.`);
    const init = { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) };
    let token = await this.accessToken(userId);
    let response = await this.api(url, init, token);
    if (response.status === 401) {
      token = await this.accessToken(userId, token);
      response = await this.api(url, init, token);
    }
    if (!response.ok) {
      const body = z.object({ error: z.object({ message: z.string().optional(), status: z.string().optional() }) }).safeParse(await response.json().catch(() => null));
      const detail = body.success ? [body.data.error.status, body.data.error.message?.slice(0, 500)].filter(Boolean).join(": ") : "";
      throw this.fail(`${name} request failed (HTTP ${response.status}${detail ? ` ${detail}` : ""}).`);
    }
    return response;
  }

  /** Calls an allowed JSON API path. Returns null for an empty (204) response. */
  async request(userId: string, path: string, method: GoogleMethod, data?: unknown): Promise<unknown> {
    const response = await this.call(userId, path, method, data);
    if (response.status === 204) return null;
    const { name } = this.product;
    try { return await response.json(); } catch { throw this.fail(`${name} returned an unreadable response. Check ${name} before retrying a change.`); }
  }

  /** Downloads an allowed path, such as a file's contents or an export, refusing anything over `maxBytes`. */
  async download(userId: string, path: string, maxBytes: number): Promise<Buffer> {
    const response = await this.call(userId, path, "GET");
    const tooLarge = () => this.fail(`The file is larger than ${Math.round(maxBytes / 1_000_000)} MB, so Pekka did not download it.`);
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    let bytes: Buffer;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch { throw this.fail(`${this.product.name} download was interrupted. Try again.`); }
    if (bytes.length > maxBytes) throw tooLarge();
    return bytes;
  }
}
