import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isPekkaCallback } from "../auth.ts";
import { ensureSchema, getDatabase, type Database } from "../database/database.ts";
import { seal, unseal } from "./secrets.ts";

const Credentials = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_at: z.number().optional() });
type Tokens = z.infer<typeof Credentials>;
type Connection = { credentials: string; workspace_name: string; enabled: number };
export type GitHubApi = (token: string, path: string, method: string, data?: unknown) => Promise<Response>;
export class GitHubError extends Error {}

type Method = "GET" | "POST" | "PATCH";
const repositoryPath = "/repos/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+";
const allowedOperations: Record<Method, RegExp> = {
  GET: new RegExp(`^(?:/user/repos|${repositoryPath}(?:/(?:issues(?:/[1-9][0-9]*(?:/comments)?)?|pulls(?:/[1-9][0-9]*(?:/files)?)?))?)$`),
  POST: new RegExp(`^${repositoryPath}/(?:issues(?:/[1-9][0-9]*/comments)?|pulls)$`),
  PATCH: /$^/,
};

function supportedOperation(path: string, method: Method) {
  const pathname = path.split("?")[0]!;
  return Boolean(allowedOperations[method]?.test(pathname)) && !/(?:[\\%#]|\/\/|\/\.{1,2}(?:\/|$))/.test(path);
}

function cliOutput(args: string[], env: NodeJS.ProcessEnv, cwd: string, data?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let exceeded = false;
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 2_000_000) { exceeded = true; child.kill(); }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); reject(new GitHubError("GitHub CLI (gh) must be installed on the Pekka server.")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!exceeded && /^HTTP\//.test(output)) resolve(output);
      else reject(new GitHubError(code === 0 ? "GitHub returned an unreadable response." : "GitHub CLI request failed. A write may have completed; check GitHub before retrying."));
    });
    child.stdin.end(data === undefined ? undefined : JSON.stringify(data));
  });
}

export const githubCliApi: GitHubApi = async (token, path, method, data) => {
  const directory = await mkdtemp(join(tmpdir(), "pekka-github-"));
  try {
    const args = ["api", path, "--hostname", "github.com", "--method", method, "--include", "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28"];
    if (data !== undefined) args.push("--input", "-");
    const output = await cliOutput(args, { PATH: process.env.PATH, GH_TOKEN: token, GH_CONFIG_DIR: directory, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" }, directory, data);
    const boundary = /\r?\n\r?\n/.exec(output);
    const status = Number(/^HTTP\/\S+ (\d{3})/.exec(output)?.[1]);
    if (!boundary || !status) throw new GitHubError("GitHub returned an unreadable response.");
    const body = output.slice(boundary.index + boundary[0].length);
    return new Response(status === 204 ? null : body, { status });
  } finally { await rm(directory, { recursive: true, force: true }); }
};

export class GitHubService {
  private readonly databaseFor: () => Database;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;
  private readonly api: GitHubApi;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: { database?: () => Database; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; api?: GitHubApi } = {}) {
    this.databaseFor = options.database ?? getDatabase;
    this.env = options.env ?? process.env;
    this.fetcher = options.fetch ?? fetch;
    this.api = options.api ?? githubCliApi;
  }

  private config() {
    const clientId = this.env.GITHUB_CLIENT_ID?.trim();
    const clientSecret = this.env.GITHUB_CLIENT_SECRET?.trim();
    const redirectUri = this.env.GITHUB_REDIRECT_URI?.trim();
    const key = this.env.PEKKA_PLUGIN_KEY?.trim();
    if (!clientId || !clientSecret || !redirectUri || !key || !/^[a-f\d]{64}$/i.test(key)) throw new GitHubError("GitHub needs GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI and a 64-character hex PEKKA_PLUGIN_KEY. See .env.example.");
    if (!isPekkaCallback(redirectUri, "/api/plugins/github/callback", this.env)) throw new GitHubError("GitHub redirect must be Pekka's /api/plugins/github/callback URL, on localhost or at PEKKA_URL.");
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
    const [row] = await database.query<Connection>("SELECT credentials, workspace_name, enabled FROM plugin_accounts WHERE user_id = ? AND plugin = 'github'", [userId]);
    return row;
  }

  async status(userId: string) {
    const base = { id: "github", name: "GitHub", configured: false, connected: false, enabled: false, workspaceName: "" };
    try { this.config(); } catch { return base; }
    const row = await this.connection(await this.database(), userId);
    return { ...base, configured: true, connected: !!row, enabled: Number(row?.enabled) === 1, workspaceName: row?.workspace_name ?? "" };
  }

  private verifier(state: string) {
    return createHmac("sha256", this.config().key).update(`pekka:github:pkce:${state}`).digest("base64url");
  }

  authorize(state: string): string {
    const config = this.config();
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, scope: "repo", state, code_challenge: createHash("sha256").update(this.verifier(state)).digest("base64url"), code_challenge_method: "S256" }).toString();
    return url.href;
  }

  private encrypt(tokens: Tokens) { return seal(this.config().key, "pekka:github:v1", JSON.stringify(tokens)); }
  private decrypt(value: string): Tokens {
    try { return Credentials.parse(JSON.parse(unseal(this.config().key, "pekka:github:v1", value))); }
    catch { throw new GitHubError("Cannot unlock the GitHub connection. Restore PEKKA_PLUGIN_KEY or reconnect GitHub."); }
  }

  private async oauth(url: string, method: string, data: unknown, basic = false): Promise<Response> {
    const config = this.config();
    try {
      return await this.fetcher(url, { method, redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json", "Content-Type": "application/json", ...(basic ? { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` } : {}) }, body: JSON.stringify(data) });
    } catch { throw new GitHubError("Could not reach GitHub. Recheck the connection in Plugins before retrying."); }
  }

  private async json(response: Response): Promise<unknown> {
    if (!response.ok) throw new GitHubError(`GitHub request failed (HTTP ${response.status}). Check connection permissions in Plugins. Do not automatically retry a write.`);
    if (response.status === 204) return {};
    try { return await response.json(); } catch { throw new GitHubError("GitHub returned an unreadable response. Check GitHub before retrying a write."); }
  }

  private async token(data: Record<string, string>): Promise<Tokens> {
    const config = this.config();
    const response = await this.json(await this.oauth("https://github.com/login/oauth/access_token", "POST", { client_id: config.clientId, client_secret: config.clientSecret, ...data }));
    const parsed = Credentials.omit({ expires_at: true }).extend({ expires_in: z.number().positive().optional() }).safeParse(response);
    if (!parsed.success) throw new GitHubError("GitHub rejected the connection. Please reconnect.");
    const { expires_in, ...tokens } = parsed.data;
    return { ...tokens, ...(expires_in ? { expires_at: Date.now() + expires_in * 1000 } : {}) };
  }

  exchange(userId: string, code: string, state?: string): Promise<void> {
    return this.serial(async () => {
      if (!state) throw new GitHubError("GitHub connection state is missing. Please reconnect.");
      const tokens = await this.token({ code, redirect_uri: this.config().redirectUri, code_verifier: this.verifier(state) });
      const identity = z.object({ login: z.string().min(1) }).safeParse(await this.json(await this.api(tokens.access_token, "/user", "GET")));
      if (!identity.success) throw new GitHubError("GitHub returned an invalid account. Please reconnect.");
      const database = await this.database();
      await database.run("INSERT INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled) VALUES (?, 'github', ?, ?, 0) ON CONFLICT(user_id, plugin) DO UPDATE SET credentials = excluded.credentials, workspace_name = excluded.workspace_name, enabled = 0", [userId, this.encrypt(tokens), identity.data.login]);
    });
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    const database = await this.database();
    if (enabled) {
      const row = await this.connection(database, userId);
      if (!row) throw new GitHubError("Connect GitHub before allowing access.");
      this.decrypt(row.credentials);
    }
    await database.run("UPDATE plugin_accounts SET enabled = ? WHERE user_id = ? AND plugin = 'github'", [enabled ? 1 : 0, userId]);
  }

  async disconnect(userId: string): Promise<void> {
    await this.setEnabled(userId, false);
    return this.serial(async () => {
      const database = await this.database();
      const row = await this.connection(database, userId);
      if (!row) return;
      const tokens = this.decrypt(row.credentials);
      const response = await this.oauth(`https://api.github.com/applications/${encodeURIComponent(this.config().clientId)}/token`, "DELETE", { access_token: tokens.access_token }, true);
      if (!response.ok && response.status !== 404) throw new GitHubError("GitHub access is disabled, but revocation failed. Retry Disconnect or revoke the OAuth app in GitHub settings.");
      await database.run("DELETE FROM plugin_accounts WHERE user_id = ? AND plugin = 'github' AND credentials = ?", [userId, row.credentials]);
    });
  }

  private async enabledConnection(database: Database, userId: string): Promise<Connection> {
    const row = await this.connection(database, userId);
    if (!row || Number(row.enabled) !== 1) throw new GitHubError("GitHub access is off. Connect GitHub and allow Pekka access in Plugins.");
    return row;
  }

  private async refresh(database: Database, userId: string, row: Connection, tokens: Tokens): Promise<Tokens> {
    if (!tokens.refresh_token) throw new GitHubError("GitHub access expired. Reconnect in Plugins.");
    const refreshed = await this.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    const credentials = this.encrypt(refreshed);
    const update = await database.run("UPDATE plugin_accounts SET credentials = ? WHERE user_id = ? AND plugin = 'github' AND credentials = ?", [credentials, userId, row.credentials]);
    const current = await this.enabledConnection(database, userId);
    if (!update.changes || current.credentials !== credentials) throw new GitHubError("GitHub connection changed. Try again if access is still enabled.");
    return refreshed;
  }

  request(userId: string, path: string, method: Method, data?: unknown): Promise<unknown> {
    return this.serial(async () => {
      this.config();
      if (!supportedOperation(path, method)) throw new GitHubError("Unsupported GitHub operation.");
      const database = await this.database();
      const row = await this.enabledConnection(database, userId);
      let tokens = this.decrypt(row.credentials);
      if (tokens.expires_at && tokens.expires_at <= Date.now() + 30_000) tokens = await this.refresh(database, userId, row, tokens);
      return this.json(await this.api(tokens.access_token, path, method, data));
    });
  }
}

let defaultService: GitHubService | undefined;
export function getGitHubService(): GitHubService { return defaultService ??= new GitHubService(); }
