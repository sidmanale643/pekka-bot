import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { isPekkaCallback } from "../auth.ts";
import { ensureSchema, getDatabase, type Database } from "../database/database.ts";
import { seal, unseal } from "./secrets.ts";

const Credentials = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_at: z.number().optional() });
type Tokens = z.infer<typeof Credentials>;
type Connection = { credentials: string; workspace_name: string; enabled: number };
export class LinearError extends Error {}

const API = "https://api.linear.app";
const ISSUE_SUMMARY = "id identifier title url priority priorityLabel updatedAt dueDate state { name type } assignee { name } team { key name }";

/** The only GraphQL documents Pekka sends, so a tool can never run an arbitrary query or mutation. */
export const OPERATIONS = {
  viewer: "query Viewer { viewer { id name organization { name } } }",
  teams: "query Teams($first: Int!, $after: String) { viewer { id name } teams(first: $first, after: $after) { nodes { id key name states { nodes { id name type } } members(first: 100) { nodes { id name displayName } } } pageInfo { hasNextPage endCursor } } }",
  issues: `query Issues($filter: IssueFilter, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { ${ISSUE_SUMMARY} } pageInfo { hasNextPage endCursor } } }`,
  searchIssues: `query SearchIssues($term: String!, $first: Int!, $after: String) { searchIssues(term: $term, first: $first, after: $after) { nodes { ${ISSUE_SUMMARY} } pageInfo { hasNextPage endCursor } } }`,
  issue: `query Issue($id: String!) { issue(id: $id) { ${ISSUE_SUMMARY} description createdAt estimate labels { nodes { name } } project { name } cycle { number name } parent { identifier title } comments(first: 50) { nodes { body createdAt user { name } } } } }`,
  createIssue: "mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url state { name } assignee { name } } } }",
  updateIssue: "mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title url priorityLabel state { name } assignee { name } } } }",
  createComment: "mutation CreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }",
} as const;
export type LinearOperation = keyof typeof OPERATIONS;

export class LinearService {
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
    const clientId = this.env.LINEAR_CLIENT_ID?.trim();
    const clientSecret = this.env.LINEAR_CLIENT_SECRET?.trim();
    const redirectUri = this.env.LINEAR_REDIRECT_URI?.trim();
    const key = this.env.PEKKA_PLUGIN_KEY?.trim();
    if (!clientId || !clientSecret || !redirectUri || !key || !/^[a-f\d]{64}$/i.test(key)) throw new LinearError("Linear needs LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_REDIRECT_URI and a 64-character hex PEKKA_PLUGIN_KEY. See .env.example.");
    if (!isPekkaCallback(redirectUri, "/api/plugins/linear/callback", this.env)) throw new LinearError("Linear redirect must be Pekka's /api/plugins/linear/callback URL, on localhost or at PEKKA_URL.");
    return { clientId, clientSecret, redirectUri, key: Buffer.from(key, "hex") };
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
    const [row] = await database.query<Connection>("SELECT credentials, workspace_name, enabled FROM plugin_accounts WHERE user_id = ? AND plugin = 'linear'", [userId]);
    return row;
  }

  async status(userId: string) {
    const base = { id: "linear", name: "Linear", configured: false, connected: false, enabled: false, workspaceName: "" };
    try { this.config(); } catch { return base; }
    const row = await this.connection(await this.database(), userId);
    return { ...base, configured: true, connected: !!row, enabled: Number(row?.enabled) === 1, workspaceName: row?.workspace_name ?? "" };
  }

  private verifier(state: string) {
    return createHmac("sha256", this.config().key).update(`pekka:linear:pkce:${state}`).digest("base64url");
  }

  authorize(state: string): string {
    const config = this.config();
    const url = new URL("https://linear.app/oauth/authorize");
    // write lets bots change issues they're asked to update; Linear has no narrower scope for that.
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: "read,write", state, code_challenge: createHash("sha256").update(this.verifier(state)).digest("base64url"), code_challenge_method: "S256" }).toString();
    return url.href;
  }

  private encrypt(tokens: Tokens) { return seal(this.config().key, "pekka:linear:v1", JSON.stringify(tokens)); }
  private decrypt(value: string): Tokens {
    try { return Credentials.parse(JSON.parse(unseal(this.config().key, "pekka:linear:v1", value))); }
    catch { throw new LinearError("Cannot unlock the Linear connection. Restore PEKKA_PLUGIN_KEY or reconnect Linear."); }
  }

  private async post(path: string, init: { headers: Record<string, string>; body: string }): Promise<Response> {
    try {
      return await this.fetcher(`${API}${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000), ...init });
    } catch { throw new LinearError("Could not reach Linear. A write may have completed; check Linear before retrying."); }
  }

  private form(data: Record<string, string>) {
    return { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(data).toString() };
  }

  private async token(data: Record<string, string>): Promise<Tokens> {
    const config = this.config();
    const response = await this.post("/oauth/token", this.form({ client_id: config.clientId, client_secret: config.clientSecret, ...data }));
    const parsed = Credentials.omit({ expires_at: true }).extend({ expires_in: z.number().positive().optional() }).safeParse(response.ok ? await response.json().catch(() => null) : null);
    if (!parsed.success) throw new LinearError("Linear rejected the connection. Reconnect Linear in Plugins.");
    const { expires_in, ...tokens } = parsed.data;
    return { ...tokens, ...(expires_in ? { expires_at: Date.now() + expires_in * 1000 } : {}) };
  }

  private async graphql(accessToken: string, operation: LinearOperation, variables: Record<string, unknown>): Promise<unknown> {
    const response = await this.post("/graphql", { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: OPERATIONS[operation], variables }) });
    const parsed = z.object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string() })).optional() }).safeParse(await response.json().catch(() => null));
    // Linear can answer 200 with errors when part of a request failed, so errors fail the whole call.
    if (!response.ok || !parsed.success || parsed.data.errors?.length) {
      const detail = parsed.success ? (parsed.data.errors ?? []).map(({ message }) => message).join("; ").slice(0, 500) : "";
      throw new LinearError(`Linear request failed (HTTP ${response.status}${detail ? `: ${detail}` : ""}). Check connection permissions in Plugins. Do not automatically retry a write.`);
    }
    return parsed.data.data ?? {};
  }

  exchange(userId: string, code: string, state?: string): Promise<void> {
    return this.serial(async () => {
      if (!state) throw new LinearError("Linear connection state is missing. Please reconnect.");
      const tokens = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.config().redirectUri, code_verifier: this.verifier(state) });
      const identity = z.object({ viewer: z.object({ name: z.string(), organization: z.object({ name: z.string().min(1) }) }) }).safeParse(await this.graphql(tokens.access_token, "viewer", {}));
      if (!identity.success) throw new LinearError("Linear returned an invalid account. Please reconnect.");
      const database = await this.database();
      await database.run("INSERT INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled) VALUES (?, 'linear', ?, ?, 0) ON CONFLICT(user_id, plugin) DO UPDATE SET credentials = excluded.credentials, workspace_name = excluded.workspace_name, enabled = 0", [userId, this.encrypt(tokens), identity.data.viewer.organization.name]);
    });
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    const database = await this.database();
    if (enabled) {
      const row = await this.connection(database, userId);
      if (!row) throw new LinearError("Connect Linear before allowing access.");
      this.decrypt(row.credentials);
    }
    await database.run("UPDATE plugin_accounts SET enabled = ? WHERE user_id = ? AND plugin = 'linear'", [enabled ? 1 : 0, userId]);
  }

  async disconnect(userId: string): Promise<void> {
    await this.setEnabled(userId, false);
    return this.serial(async () => {
      const database = await this.database();
      const row = await this.connection(database, userId);
      if (!row) return;
      const tokens = this.decrypt(row.credentials);
      // Revoking the refresh token ends the whole grant, including access tokens issued from it.
      const [token, hint] = tokens.refresh_token ? [tokens.refresh_token, "refresh_token"] : [tokens.access_token, "access_token"];
      const response = await this.post("/oauth/revoke", this.form({ token, token_type_hint: hint }));
      // Linear answers 400 when it can't revoke a token, as when the user already removed Pekka in Linear, so dropping our copy is safe.
      if (!response.ok && response.status !== 400) throw new LinearError("Linear access is disabled, but revocation failed. Retry Disconnect or revoke Pekka in Linear's settings.");
      await database.run("DELETE FROM plugin_accounts WHERE user_id = ? AND plugin = 'linear' AND credentials = ?", [userId, row.credentials]);
    });
  }

  private async enabledConnection(database: Database, userId: string): Promise<Connection> {
    const row = await this.connection(database, userId);
    if (!row || Number(row.enabled) !== 1) throw new LinearError("Linear access is off. Connect Linear and allow Pekka access in Plugins.");
    return row;
  }

  private async refresh(database: Database, userId: string, row: Connection, tokens: Tokens): Promise<Tokens> {
    if (!tokens.refresh_token) throw new LinearError("Linear access expired. Reconnect Linear in Plugins.");
    // Each refresh also replaces the refresh token, so the new pair must be saved before it is used.
    const refreshed = await this.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    const credentials = this.encrypt(refreshed);
    const update = await database.run("UPDATE plugin_accounts SET credentials = ? WHERE user_id = ? AND plugin = 'linear' AND credentials = ?", [credentials, userId, row.credentials]);
    const current = await this.enabledConnection(database, userId);
    if (!update.changes || current.credentials !== credentials) throw new LinearError("Linear connection changed. Try again if access is still enabled.");
    return refreshed;
  }

  /** Runs one of the fixed GraphQL operations with `userId`'s connection. */
  request(userId: string, operation: LinearOperation, variables: Record<string, unknown> = {}): Promise<unknown> {
    return this.serial(async () => {
      this.config();
      if (!Object.hasOwn(OPERATIONS, operation)) throw new LinearError("Unsupported Linear operation.");
      const database = await this.database();
      const row = await this.enabledConnection(database, userId);
      let tokens = this.decrypt(row.credentials);
      if (tokens.expires_at && tokens.expires_at <= Date.now() + 30_000) tokens = await this.refresh(database, userId, row, tokens);
      return this.graphql(tokens.access_token, operation, variables);
    });
  }
}

let defaultService: LinearService | undefined;
export function getLinearService(): LinearService { return defaultService ??= new LinearService(); }
