import { ensureSchema, getDatabase, type Database } from "../database/database.ts";
import { seal, unseal } from "./secrets.ts";

type Connection = { credentials: string; workspace_name: string; enabled: number };
export class ApiKeyPluginError extends Error {}

export interface ApiKeyPluginOptions {
  id: string;
  name: string;
  /** Prefix every request path is joined to. */
  baseUrl: string;
  /** Checks a pasted key and returns the account name shown on the Plugins page. Throws when the key doesn't work. */
  check(request: (path: string) => Promise<unknown>): Promise<string>;
  database?: () => Database;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/**
 * A plugin the user connects by pasting their own API key, for services that
 * offer personal tokens. Keys are sealed with PEKKA_PLUGIN_KEY and sent as a
 * bearer token, so the self-hoster doesn't need to register an OAuth app.
 */
export class ApiKeyPlugin {
  readonly id: string;
  readonly name: string;
  private readonly options: ApiKeyPluginOptions;
  private readonly databaseFor: () => Database;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;

  constructor(options: ApiKeyPluginOptions) {
    this.id = options.id;
    this.name = options.name;
    this.options = options;
    this.databaseFor = options.database ?? getDatabase;
    this.env = options.env ?? process.env;
    this.fetcher = options.fetch ?? fetch;
  }

  private sealingKey(): Buffer {
    const key = this.env.PEKKA_PLUGIN_KEY?.trim();
    if (!key || !/^[a-f\d]{64}$/i.test(key)) throw new ApiKeyPluginError(`${this.name} needs a 64-character hex PEKKA_PLUGIN_KEY on the server to store your key. See .env.example.`);
    return Buffer.from(key, "hex");
  }

  private label(userId: string) { return `pekka:${this.id}:v1:${userId}`; }

  private async database() {
    const database = this.databaseFor();
    await ensureSchema(database);
    return database;
  }

  private async connection(database: Database, userId: string): Promise<Connection | undefined> {
    const [row] = await database.query<Connection>("SELECT credentials, workspace_name, enabled FROM plugin_accounts WHERE user_id = ? AND plugin = ?", [userId, this.id]);
    return row;
  }

  async status(userId: string) {
    const base = { id: this.id, name: this.name, configured: false, connected: false, enabled: false, workspaceName: "" };
    try { this.sealingKey(); } catch { return base; }
    const row = await this.connection(await this.database(), userId);
    return { ...base, configured: true, connected: !!row, enabled: Number(row?.enabled) === 1, workspaceName: row?.workspace_name ?? "" };
  }

  /** Checks the key with the service, saves it and turns access on. */
  async connect(userId: string, apiKey: string): Promise<void> {
    const key = this.sealingKey();
    const account = await this.options.check((path) => this.send(apiKey, path));
    await (await this.database()).run(
      "INSERT INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled) VALUES (?, ?, ?, ?, 1) ON CONFLICT(user_id, plugin) DO UPDATE SET credentials = excluded.credentials, workspace_name = excluded.workspace_name, enabled = 1",
      [userId, this.id, seal(key, this.label(userId), apiKey), account.slice(0, 200)],
    );
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    const database = await this.database();
    if (enabled && !await this.connection(database, userId)) throw new ApiKeyPluginError(`Add your ${this.name} API key before allowing access.`);
    await database.run("UPDATE plugin_accounts SET enabled = ? WHERE user_id = ? AND plugin = ?", [enabled ? 1 : 0, userId, this.id]);
  }

  /** Forgets the saved key. It stays valid at the service until the user deletes it there. */
  async disconnect(userId: string): Promise<void> {
    await (await this.database()).run("DELETE FROM plugin_accounts WHERE user_id = ? AND plugin = ?", [userId, this.id]);
  }

  private async send(apiKey: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new ApiKeyPluginError(`Could not reach ${this.name}. A write may have completed; check ${this.name} before retrying.`); }
    const text = await response.text();
    if (response.status === 401 || response.status === 403) throw new ApiKeyPluginError(`${this.name} rejected the API key. Add a new key in Plugins.`);
    if (!response.ok) throw new ApiKeyPluginError(`${this.name} request failed (HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}). Do not automatically retry a write.`);
    if (!text) return { ok: true };
    try { return JSON.parse(text); } catch { return text; }
  }

  /** Calls the service as `userId`, once they've added a key and allowed access. */
  async request(userId: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const key = this.sealingKey();
    const row = await this.connection(await this.database(), userId);
    if (!row || Number(row.enabled) !== 1) throw new ApiKeyPluginError(`${this.name} access is off. Add your ${this.name} API key and allow Pekka access in Plugins.`);
    let apiKey: string;
    try { apiKey = unseal(key, this.label(userId), row.credentials); }
    catch { throw new ApiKeyPluginError(`Cannot unlock the saved ${this.name} key. Restore PEKKA_PLUGIN_KEY or add the key again.`); }
    return this.send(apiKey, path, init);
  }
}
