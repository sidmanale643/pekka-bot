import { createHash, createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { isPekkaCallback } from "../auth.ts";
import { ensureSchema, getDatabase, type Database } from "../database/database.ts";
import { seal, unseal } from "./secrets.ts";

const SERVER = "https://ai.todoist.net/mcp";
const AUTH = "https://todoist.com/oauth";
const Credentials = z.object({ client_id: z.string().min(1), access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_at: z.number().optional() });
type Tokens = z.infer<typeof Credentials>;
type Connection = { credentials: string; enabled: number };
export class TodoistError extends Error {}

export class TodoistService {
  private readonly databaseFor: () => Database;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;
  private registration?: Promise<string>;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: { database?: () => Database; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
    this.databaseFor = options.database ?? getDatabase;
    this.env = options.env ?? process.env;
    this.fetcher = options.fetch ?? fetch;
  }

  private config() {
    const key = this.env.PEKKA_PLUGIN_KEY?.trim();
    const redirectUri = this.env.TODOIST_REDIRECT_URI?.trim() || `${this.env.PEKKA_URL?.trim().replace(/\/+$/, "") || "http://localhost:3000"}/api/plugins/todoist/callback`;
    if (!key || !/^[a-f\d]{64}$/i.test(key)) throw new TodoistError("Todoist needs a 64-character hex PEKKA_PLUGIN_KEY. See .env.example.");
    if (!isPekkaCallback(redirectUri, "/api/plugins/todoist/callback", this.env)) throw new TodoistError("Todoist redirect must be Pekka's /api/plugins/todoist/callback URL, on localhost or at PEKKA_URL.");
    return { key: Buffer.from(key, "hex"), redirectUri };
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

  private async connection(database: Database, userId: string) {
    const [row] = await database.query<Connection>("SELECT credentials, enabled FROM plugin_accounts WHERE user_id = ? AND plugin = 'todoist'", [userId]);
    return row;
  }

  async status(userId: string) {
    const base = { id: "todoist", name: "Todoist", configured: false, connected: false, enabled: false, workspaceName: "" };
    try { this.config(); } catch { return base; }
    let row = await this.connection(await this.database(), userId);
    if (row) { try { this.decrypt(row.credentials); } catch { row = undefined; } }
    return { ...base, configured: true, connected: !!row, enabled: Number(row?.enabled) === 1, workspaceName: row ? "your Todoist account" : "" };
  }

  private verifier(state: string) {
    return createHmac("sha256", this.config().key).update(`pekka:todoist:pkce:${state}`).digest("base64url");
  }

  private async post(path: string, body: string, contentType: string) {
    try {
      const response = await this.fetcher(`${AUTH}/${path}`, { method: "POST", headers: { "Content-Type": contentType, Accept: "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw new TodoistError("Todoist could not authorize Pekka. Try reconnecting in Plugins."); }
  }

  private clientId(): Promise<string> {
    return this.registration ??= this.post("register", JSON.stringify({ client_name: "Pekka", redirect_uris: [this.config().redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }), "application/json")
      .then((value) => z.object({ client_id: z.string().min(1) }).parse(value).client_id)
      .catch(() => { this.registration = undefined; throw new TodoistError("Todoist client registration failed. Try again."); });
  }

  async authorize(state: string): Promise<string> {
    const config = this.config();
    const url = new URL(`${AUTH}/authorize`);
    url.search = new URLSearchParams({ client_id: await this.clientId(), redirect_uri: config.redirectUri, response_type: "code", scope: "data:read_write", resource: SERVER, state, code_challenge: createHash("sha256").update(this.verifier(state)).digest("base64url"), code_challenge_method: "S256" }).toString();
    return url.href;
  }

  private encrypt(tokens: Tokens) { return seal(this.config().key, "pekka:todoist:v1", JSON.stringify(tokens)); }
  private decrypt(value: string): Tokens {
    try { return Credentials.parse(JSON.parse(unseal(this.config().key, "pekka:todoist:v1", value))); }
    catch { throw new TodoistError("Cannot unlock the Todoist connection. Restore PEKKA_PLUGIN_KEY or reconnect."); }
  }

  private async token(clientId: string, data: Record<string, string>): Promise<Tokens> {
    const value = await this.post("access_token", new URLSearchParams({ client_id: clientId, resource: SERVER, ...data }).toString(), "application/x-www-form-urlencoded");
    const parsed = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive().optional(), token_type: z.string() }).safeParse(value);
    if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") throw new TodoistError("Todoist returned invalid credentials. Reconnect in Plugins.");
    const { expires_in, token_type: _, ...tokens } = parsed.data;
    return { ...tokens, client_id: clientId, ...(expires_in ? { expires_at: Date.now() + expires_in * 1000 } : {}) };
  }

  exchange(userId: string, code: string, state?: string): Promise<void> {
    return this.serial(async () => {
      if (!state || !this.registration) throw new TodoistError("Todoist connection state is missing. Please reconnect.");
      const tokens = await this.token(await this.registration, { grant_type: "authorization_code", code, redirect_uri: this.config().redirectUri, code_verifier: this.verifier(state) });
      const database = await this.database();
      await database.run("INSERT INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled) VALUES (?, 'todoist', ?, 'Todoist', 0) ON CONFLICT(user_id, plugin) DO UPDATE SET credentials = excluded.credentials, workspace_name = excluded.workspace_name, enabled = 0", [userId, this.encrypt(tokens)]);
    });
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    const database = await this.database();
    if (enabled) {
      const row = await this.connection(database, userId);
      if (!row) throw new TodoistError("Connect Todoist before allowing access.");
      this.decrypt(row.credentials);
    }
    await database.run("UPDATE plugin_accounts SET enabled = ? WHERE user_id = ? AND plugin = 'todoist'", [enabled ? 1 : 0, userId]);
  }

  async disconnect(userId: string): Promise<void> {
    await this.setEnabled(userId, false);
    await this.serial(async () => {
      await (await this.database()).run("DELETE FROM plugin_accounts WHERE user_id = ? AND plugin = 'todoist'", [userId]);
    });
  }

  private async enabledConnection(database: Database, userId: string) {
    const row = await this.connection(database, userId);
    if (!row || Number(row.enabled) !== 1) throw new TodoistError("Todoist access is off. Connect it and allow Pekka access in Plugins.");
    return row;
  }

  request(userId: string, name?: string, args: Record<string, unknown> = {}, signal?: AbortSignal, readOnly = true): Promise<unknown> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const database = await this.database();
      let row = await this.enabledConnection(database, userId);
      let tokens = this.decrypt(row.credentials);
      if (tokens.expires_at && tokens.expires_at <= Date.now() + 30_000) {
        if (!tokens.refresh_token) throw new TodoistError("Todoist access expired. Reconnect in Plugins.");
        const refreshed = await this.token(tokens.client_id, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
        tokens = { ...refreshed, refresh_token: refreshed.refresh_token ?? tokens.refresh_token };
        const credentials = this.encrypt(tokens);
        const update = await database.run("UPDATE plugin_accounts SET credentials = ? WHERE user_id = ? AND plugin = 'todoist' AND credentials = ?", [credentials, userId, row.credentials]);
        row = await this.enabledConnection(database, userId);
        if (!update.changes || row.credentials !== credentials) throw new TodoistError("Todoist connection changed. Try again if access is still enabled.");
      }
      const client = new Client({ name: "pekka", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(SERVER), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` }, redirect: "error" },
        fetch: (url, init) => this.fetcher(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]) }),
      });
      try {
        await client.connect(transport);
        const tools = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          if (++pages > 20) throw new TodoistError("Todoist returned too many tool pages.");
          const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (tools.length > 200) throw new TodoistError("Todoist returned too many tools.");
        } while (cursor);
        if (!name) return { tools };
        const tool = tools.find((tool) => tool.name === name);
        if (!tool) throw new TodoistError("Choose a tool returned by todoist_list_tools.");
        if (readOnly && tool.annotations?.readOnlyHint !== true) throw new TodoistError("Use todoist_write_tool for tools that are not explicitly read-only.");
        const current = await this.enabledConnection(database, userId);
        if (current.credentials !== row.credentials) throw new TodoistError("Todoist connection changed. Try again.");
        return await client.callTool({ name, arguments: args }, undefined, { signal });
      } catch (error) {
        if (error instanceof TodoistError) throw error;
        throw new TodoistError("Todoist request failed. Check your connection and account access, or reconnect in Plugins.");
      } finally { await client.close().catch(() => {}); }
    });
  }
}

let defaultService: TodoistService | undefined;
export function getTodoistService(): TodoistService { return defaultService ??= new TodoistService(); }

export function createTodoistService(options: ConstructorParameters<typeof TodoistService>[0] = {}): TodoistService { return new TodoistService(options); }
