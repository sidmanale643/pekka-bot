import { z } from "zod";
import { isPekkaCallback } from "../auth.ts";
import { ensureSchema, getDatabase, type Database } from "../database/database.ts";
import { seal, unseal } from "./secrets.ts";

const Credentials = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).nullish() });
type Tokens = z.infer<typeof Credentials>;
type Connection = { credentials: string; workspace_name: string; enabled: number };
const VERSION = "2026-03-11";

export class NotionError extends Error {}

export class NotionService {
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
    const clientId = this.env.NOTION_CLIENT_ID?.trim();
    const clientSecret = this.env.NOTION_CLIENT_SECRET?.trim();
    const redirectUri = this.env.NOTION_REDIRECT_URI?.trim();
    const key = this.env.PEKKA_PLUGIN_KEY?.trim();
    if (!clientId || !clientSecret || !redirectUri || !key || !/^[a-f\d]{64}$/i.test(key)) {
      throw new NotionError("Notion needs NOTION_CLIENT_ID, NOTION_CLIENT_SECRET, NOTION_REDIRECT_URI and a 64-character hex PEKKA_PLUGIN_KEY. See .env.example.");
    }
    this.validateRedirect(redirectUri);
    return { clientId, clientSecret, redirectUri, key: Buffer.from(key, "hex") };
  }

  private validateRedirect(uri: string) {
    if (!isPekkaCallback(uri, "/api/plugins/notion/callback", this.env)) {
      throw new NotionError("Notion redirect must be Pekka's /api/plugins/notion/callback URL, on localhost or at PEKKA_URL.");
    }
  }

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
    const [row] = await database.query<Connection>("SELECT credentials, workspace_name, enabled FROM plugin_accounts WHERE user_id = ? AND plugin = ?", [userId, "notion"]);
    return row;
  }

  async status(userId: string) {
    const base = { id: "notion", name: "Notion", configured: false, connected: false, enabled: false, workspaceName: "" };
    try { this.config(); } catch { return base; }
    const row = await this.connection(await this.database(), userId);
    return { ...base, configured: true, connected: !!row, enabled: Number(row?.enabled) === 1, workspaceName: row?.workspace_name ?? "" };
  }

  authorize(state: string): string {
    const config = this.config();
    const url = new URL("https://api.notion.com/v1/oauth/authorize");
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", owner: "user", state }).toString();
    return url.href;
  }

  private encrypt(tokens: Tokens): string {
    return seal(this.config().key, "pekka:notion:v1", JSON.stringify(tokens));
  }

  private decrypt(value: string): Tokens {
    try { return Credentials.parse(JSON.parse(unseal(this.config().key, "pekka:notion:v1", value))); }
    catch { throw new NotionError("Cannot unlock the Notion connection. Restore PEKKA_PLUGIN_KEY or reconnect Notion."); }
  }

  private async send(path: string, method: string, authorization: string, data?: unknown) {
    try {
      return await this.fetcher(`https://api.notion.com/v1${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: authorization, "Notion-Version": VERSION, "Content-Type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    } catch { throw new NotionError("Could not reach Notion. A write may have completed; check Notion before retrying."); }
  }

  private async failure(response: Response): Promise<{ code?: string; message?: string }> {
    const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : {};
  }

  private async json(response: Response): Promise<unknown> {
    if (!response.ok) {
      const { code, message } = await this.failure(response);
      const detail = [code, message?.slice(0, 500)].filter(Boolean).join(": ");
      throw new NotionError(`Notion request failed (HTTP ${response.status}${detail ? ` ${detail}` : ""}). Check connection permissions in Plugins.`);
    }
    try { return await response.json(); } catch { throw new NotionError("Notion returned an unreadable response. Check Notion before retrying a write."); }
  }

  private basic() {
    const config = this.config();
    return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  }

  private async token(data: unknown) {
    const result = await this.json(await this.send("/oauth/token", "POST", this.basic(), data));
    const parsed = Credentials.extend({ workspace_name: z.string().nullish() }).safeParse(result);
    if (!parsed.success) throw new NotionError("Notion returned an invalid connection response. Please reconnect.");
    return parsed.data;
  }

  exchange(userId: string, code: string): Promise<void> {
    return this.serial(async () => {
      const database = await this.database();
      const tokens = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.config().redirectUri });
      await database.run("INSERT INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled) VALUES (?, ?, ?, ?, 0) ON CONFLICT(user_id, plugin) DO UPDATE SET credentials = excluded.credentials, workspace_name = excluded.workspace_name, enabled = 0", [userId, "notion", this.encrypt(Credentials.parse(tokens)), tokens.workspace_name ?? "Notion workspace"]);
    });
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    const database = await this.database();
    if (enabled) {
      this.config();
      const row = await this.connection(database, userId);
      if (!row) throw new NotionError("Connect Notion before allowing access.");
      this.decrypt(row.credentials);
    }
    await database.run("UPDATE plugin_accounts SET enabled = ? WHERE user_id = ? AND plugin = ?", [enabled ? 1 : 0, userId, "notion"]);
  }

  async disconnect(userId: string): Promise<void> {
    await this.setEnabled(userId, false);
    return this.serial(async () => {
      const database = await this.database();
      const row = await this.connection(database, userId);
      if (!row) return;
      const tokens = this.decrypt(row.credentials);
      const response = await this.send("/oauth/revoke", "POST", this.basic(), { token: tokens.access_token });
      // invalid_grant means the token is already dead at Notion (e.g. removed there), so dropping our copy is safe.
      if (!response.ok && (response.status !== 400 || (await this.failure(response)).code !== "invalid_grant")) throw new NotionError("Notion access is disabled, but revocation failed. Retry Disconnect or remove the connection in Notion.");
      await database.run("DELETE FROM plugin_accounts WHERE user_id = ? AND plugin = ? AND credentials = ?", [userId, "notion", row.credentials]);
    });
  }

  private async enabledConnection(database: Database, userId: string): Promise<Connection> {
    const row = await this.connection(database, userId);
    if (!row || Number(row.enabled) !== 1) throw new NotionError("Notion access is off. Connect Notion and allow Pekka access in Plugins.");
    return row;
  }

  private async refresh(database: Database, userId: string, previous: Connection, refreshToken: string): Promise<Tokens> {
    await this.enabledConnection(database, userId);
    const refreshed = await this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
    const credentials = this.encrypt(Credentials.parse(refreshed));
    const update = await database.run("UPDATE plugin_accounts SET credentials = ? WHERE user_id = ? AND plugin = ? AND credentials = ?", [credentials, userId, "notion", previous.credentials]);
    if (!update.changes) throw new NotionError("Notion access changed during the request. Try again if access is still enabled.");
    const row = await this.enabledConnection(database, userId);
    if (row.credentials !== credentials) throw new NotionError("Notion connection changed. Try again.");
    return this.decrypt(row.credentials);
  }

  /** Calls the Notion API with `userId`'s connection. */
  request(userId: string, path: string, method: "GET" | "POST" | "PATCH", data?: unknown): Promise<unknown> {
    return this.serial(async () => {
      this.config();
      if (!/^\/(?:search|pages(?:\/[a-f\d-]+)?|blocks\/[a-f\d-]+\/children)(?:\?[^#]*)?$/i.test(path)) throw new NotionError("Unsupported Notion operation.");
      const database = await this.database();
      const row = await this.enabledConnection(database, userId);
      let tokens = this.decrypt(row.credentials);
      let response = await this.send(path, method, `Bearer ${tokens.access_token}`, data);
      if (response.status === 401 && tokens.refresh_token) {
        tokens = await this.refresh(database, userId, row, tokens.refresh_token);
        response = await this.send(path, method, `Bearer ${tokens.access_token}`, data);
      }
      return this.json(response);
    });
  }
}

let defaultService: NotionService | undefined;
export function getNotionService(): NotionService {
  return defaultService ??= new NotionService();
}
