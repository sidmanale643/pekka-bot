import { createHash, createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { isPekkaCallback } from "../auth.ts";
import { ensureSchema, getDatabase, type Database } from "../database/database.ts";
import { seal, unseal } from "./secrets.ts";

const SERVER = "https://api.wisprflow.ai/connect/mcp";
const AUTH = "https://mcp-auth.wisprflow.com/oauth2";
const Credentials = z.object({ client_id: z.string().min(1), access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_at: z.number().optional() });
type Tokens = z.infer<typeof Credentials>;
type Connection = { credentials: string; enabled: number };
export class WisprError extends Error {}

export class WisprService {
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
    const redirectUri = this.env.WISPR_FLOW_REDIRECT_URI?.trim() || `${this.env.PEKKA_URL?.trim().replace(/\/+$/, "") || "http://localhost:3000"}/api/plugins/wispr/callback`;
    if (!key || !/^[a-f\d]{64}$/i.test(key)) throw new WisprError("Wispr Flow needs a 64-character hex PEKKA_PLUGIN_KEY. See .env.example.");
    if (!isPekkaCallback(redirectUri, "/api/plugins/wispr/callback", this.env)) throw new WisprError("Wispr Flow redirect must be Pekka's /api/plugins/wispr/callback URL, on localhost or at PEKKA_URL.");
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
    const [row] = await database.query<Connection>("SELECT credentials, enabled FROM plugin_accounts WHERE user_id = ? AND plugin = 'wispr'", [userId]);
    return row;
  }

  async status(userId: string) {
    const base = { id: "wispr", name: "Wispr Flow", configured: false, connected: false, enabled: false, workspaceName: "" };
    try { this.config(); } catch { return base; }
    const row = await this.connection(await this.database(), userId);
    return { ...base, configured: true, connected: !!row, enabled: Number(row?.enabled) === 1, workspaceName: row ? "your Wispr Flow account" : "" };
  }

  private verifier(state: string) {
    return createHmac("sha256", this.config().key).update(`pekka:wispr:pkce:${state}`).digest("base64url");
  }

  private async post(path: string, body: string, contentType: string) {
    try {
      const response = await this.fetcher(`${AUTH}/${path}`, { method: "POST", headers: { "Content-Type": contentType, Accept: "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw new WisprError("Wispr Flow could not authorize Pekka. Try reconnecting in Plugins."); }
  }

  private clientId(): Promise<string> {
    return this.registration ??= this.post("register", JSON.stringify({ client_name: "Pekka", redirect_uris: [this.config().redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }), "application/json")
      .then((value) => z.object({ client_id: z.string().min(1) }).parse(value).client_id)
      .catch(() => { this.registration = undefined; throw new WisprError("Wispr Flow client registration failed. Try again."); });
  }

  async authorize(state: string): Promise<string> {
    const config = this.config();
    const url = new URL(`${AUTH}/authorize`);
    url.search = new URLSearchParams({ client_id: await this.clientId(), redirect_uri: config.redirectUri, response_type: "code", scope: "openid offline_access", resource: SERVER, state, code_challenge: createHash("sha256").update(this.verifier(state)).digest("base64url"), code_challenge_method: "S256" }).toString();
    return url.href;
  }

  private encrypt(tokens: Tokens) { return seal(this.config().key, "pekka:wispr:v1", JSON.stringify(tokens)); }
  private decrypt(value: string): Tokens {
    try { return Credentials.parse(JSON.parse(unseal(this.config().key, "pekka:wispr:v1", value))); }
    catch { throw new WisprError("Cannot unlock the Wispr Flow connection. Restore PEKKA_PLUGIN_KEY or reconnect."); }
  }

  private async token(clientId: string, data: Record<string, string>): Promise<Tokens> {
    const value = await this.post("token", new URLSearchParams({ client_id: clientId, resource: SERVER, ...data }).toString(), "application/x-www-form-urlencoded");
    const parsed = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive().optional(), token_type: z.string() }).safeParse(value);
    if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") throw new WisprError("Wispr Flow returned invalid credentials. Reconnect in Plugins.");
    const { expires_in, token_type: _, ...tokens } = parsed.data;
    return { ...tokens, client_id: clientId, ...(expires_in ? { expires_at: Date.now() + expires_in * 1000 } : {}) };
  }

  exchange(userId: string, code: string, state?: string): Promise<void> {
    return this.serial(async () => {
      if (!state || !this.registration) throw new WisprError("Wispr Flow connection state is missing. Please reconnect.");
      const tokens = await this.token(await this.registration, { grant_type: "authorization_code", code, redirect_uri: this.config().redirectUri, code_verifier: this.verifier(state) });
      const database = await this.database();
      await database.run("INSERT INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled) VALUES (?, 'wispr', ?, 'Wispr Flow', 0) ON CONFLICT(user_id, plugin) DO UPDATE SET credentials = excluded.credentials, workspace_name = excluded.workspace_name, enabled = 0", [userId, this.encrypt(tokens)]);
    });
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    const database = await this.database();
    if (enabled) {
      const row = await this.connection(database, userId);
      if (!row) throw new WisprError("Connect Wispr Flow before allowing access.");
      this.decrypt(row.credentials);
    }
    await database.run("UPDATE plugin_accounts SET enabled = ? WHERE user_id = ? AND plugin = 'wispr'", [enabled ? 1 : 0, userId]);
  }

  async disconnect(userId: string): Promise<void> {
    await this.setEnabled(userId, false);
    await this.serial(async () => {
      await (await this.database()).run("DELETE FROM plugin_accounts WHERE user_id = ? AND plugin = 'wispr'", [userId]);
    });
  }

  private async enabledConnection(database: Database, userId: string) {
    const row = await this.connection(database, userId);
    if (!row || Number(row.enabled) !== 1) throw new WisprError("Wispr Flow access is off. Connect it and allow Pekka access in Plugins.");
    return row;
  }

  request(userId: string, name?: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const database = await this.database();
      let row = await this.enabledConnection(database, userId);
      let tokens = this.decrypt(row.credentials);
      if (tokens.expires_at && tokens.expires_at <= Date.now() + 30_000) {
        if (!tokens.refresh_token) throw new WisprError("Wispr Flow access expired. Reconnect in Plugins.");
        const refreshed = await this.token(tokens.client_id, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
        tokens = { ...refreshed, refresh_token: refreshed.refresh_token ?? tokens.refresh_token };
        const credentials = this.encrypt(tokens);
        const update = await database.run("UPDATE plugin_accounts SET credentials = ? WHERE user_id = ? AND plugin = 'wispr' AND credentials = ?", [credentials, userId, row.credentials]);
        row = await this.enabledConnection(database, userId);
        if (!update.changes || row.credentials !== credentials) throw new WisprError("Wispr Flow connection changed. Try again if access is still enabled.");
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
          if (++pages > 20) throw new WisprError("Wispr Flow returned too many tool pages.");
          const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
          tools.push(...page.tools.filter((tool) => tool.annotations?.readOnlyHint !== false));
          cursor = page.nextCursor;
          if (tools.length > 200) throw new WisprError("Wispr Flow returned too many tools.");
        } while (cursor);
        if (!name) return { tools };
        if (!tools.some((tool) => tool.name === name)) throw new WisprError("Choose a read-only tool returned by wispr_list_tools.");
        const current = await this.enabledConnection(database, userId);
        if (current.credentials !== row.credentials) throw new WisprError("Wispr Flow connection changed. Try again.");
        return await client.callTool({ name, arguments: args }, undefined, { signal });
      } catch (error) {
        if (error instanceof WisprError) throw error;
        throw new WisprError("Wispr Flow request failed. Check your connection and account access, or reconnect in Plugins.");
      } finally { await client.close().catch(() => {}); }
    });
  }
}

let defaultService: WisprService | undefined;
export function getWisprService(): WisprService { return defaultService ??= new WisprService(); }
