import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { githubCliApi, GitHubService, type GitHubApi } from "./github.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let service: GitHubService;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
let api: ReturnType<typeof vi.fn<GitHubApi>>;

beforeEach(() => {
  database = createSqliteDatabase();
  upstream = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ access_token: "private-access", refresh_token: "private-refresh" }));
  api = vi.fn<GitHubApi>().mockImplementation(async (_token, path) => Response.json(path === "/user" ? { login: "octocat" } : { items: [] }));
  service = new GitHubService({ database: () => database, env: { GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret", GITHUB_REDIRECT_URI: "http://localhost:3000/api/plugins/github/callback", PEKKA_PLUGIN_KEY: "ab".repeat(32) }, fetch: upstream, api });
});

afterEach(() => { vi.restoreAllMocks(); database.close(); });

async function connect(user = "alice") {
  await service.exchange(user, "code", "browser-state");
  await service.setEnabled(user, true);
}

it("exchanges the PKCE verifier, encrypts credentials and requires explicit access", async () => {
  const url = new URL(service.authorize("browser-state"));
  expect(url.searchParams.get("scope")).toBe("repo");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  await service.exchange("alice", "code", "browser-state");
  const sent = JSON.parse(upstream.mock.calls[0]![1]!.body as string);
  expect(createHash("sha256").update(sent.code_verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
  expect(sent.redirect_uri).toBe("http://localhost:3000/api/plugins/github/callback");
  expect(api).toHaveBeenCalledWith("private-access", "/user", "GET");
  expect(await service.status("alice")).toMatchObject({ connected: true, enabled: false, workspaceName: "octocat" });
  expect(JSON.stringify(await database.query("SELECT * FROM plugin_accounts"))).not.toContain("private-");
  await expect(service.request("alice", "/user/repos", "GET")).rejects.toThrow("access is off");
  expect(api).toHaveBeenCalledTimes(1);
  await service.setEnabled("alice", true);
  await service.request("alice", "/user/repos", "GET");
  expect(api).toHaveBeenCalledTimes(2);
});

it("rejects missing exchange state and keeps tenant connections isolated", async () => {
  await expect(service.exchange("alice", "code")).rejects.toThrow("state is missing");
  expect(upstream).not.toHaveBeenCalled();
  await connect();
  expect(await service.status("bob")).toMatchObject({ connected: false, enabled: false });
  await expect(service.setEnabled("bob", true)).rejects.toThrow("Connect GitHub");
  await expect(service.request("bob", "/user/repos", "GET")).rejects.toThrow("access is off");
  await service.disconnect("bob");
  expect(await service.status("alice")).toMatchObject({ connected: true, enabled: true });
  expect(api).toHaveBeenCalledTimes(1);
});

it("blocks foreign hosts, traversal, merge, delete and unsupported API endpoints before calls", async () => {
  await connect();
  for (const [path, method] of [
    ["https://evil.example/repos/o/r/issues", "GET"], ["//evil.example/repos/o/r", "GET"],
    ["/repos/o/../issues", "GET"], ["/repos/o/r/issues?x=%2e%2e", "GET"],
    ["/repos/o/r/pulls/1/merge", "POST"], ["/repos/o/r/issues/1", "DELETE"],
    ["/repos/o/r/issues/1", "PATCH"], ["/repos/o/r/actions/secrets", "GET"],
    ["/repos/o/r/issues#fragment", "GET"],
  ] as const) {
    await expect(service.request("alice", path, method as "GET" | "POST" | "PATCH")).rejects.toThrow("Unsupported GitHub operation");
  }
  expect(api).toHaveBeenCalledTimes(1);
  await service.request("alice", "/repos/o/r/pulls/12/files?per_page=20", "GET");
  await service.request("alice", "/repos/o/r/issues/12/comments", "POST", { body: "hello" });
  expect(api).toHaveBeenLastCalledWith("private-access", "/repos/o/r/issues/12/comments", "POST", { body: "hello" });
});

it("refreshes expiring tokens once and persists rotated credentials", async () => {
  upstream.mockResolvedValueOnce(Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 1 }));
  await connect();
  upstream.mockResolvedValueOnce(Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }));
  await service.request("alice", "/user/repos", "GET");
  expect(JSON.parse(upstream.mock.calls[1]![1]!.body as string)).toMatchObject({ grant_type: "refresh_token", refresh_token: "private-refresh" });
  expect(api).toHaveBeenLastCalledWith("rotated-access", "/user/repos", "GET", undefined);
  await service.request("alice", "/user/repos", "GET");
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(await database.query("SELECT * FROM plugin_accounts"))).not.toContain("rotated-");
});

it("preserves refresh rotation when access is disabled in flight and blocks the data request", async () => {
  upstream.mockResolvedValueOnce(Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 1 }));
  await connect();
  let finish!: (response: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  upstream.mockImplementationOnce(async () => { started(); return new Promise<Response>((resolve) => { finish = resolve; }); });
  const request = service.request("alice", "/user/repos", "GET").then(() => "allowed", () => "blocked");
  await entered;
  await service.setEnabled("alice", false);
  finish(Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }));
  expect(await request).toBe("blocked");
  expect(api).toHaveBeenCalledTimes(1);
  await service.setEnabled("alice", true);
  await service.request("alice", "/user/repos", "GET");
  expect(api).toHaveBeenLastCalledWith("rotated-access", "/user/repos", "GET", undefined);
});

it("retains disabled credentials on revocation failure and deletes them on an already revoked token", async () => {
  await connect();
  upstream.mockResolvedValueOnce(Response.json({ message: "Unavailable" }, { status: 503 }));
  await expect(service.disconnect("alice")).rejects.toThrow("revocation failed");
  expect(await service.status("alice")).toMatchObject({ connected: true, enabled: false });
  await expect(service.request("alice", "/user/repos", "GET")).rejects.toThrow("access is off");
  upstream.mockResolvedValueOnce(Response.json({}, { status: 404 }));
  await service.disconnect("alice");
  expect(await service.status("alice")).toMatchObject({ connected: false, enabled: false });
  const revocation = upstream.mock.calls[2]!;
  expect(revocation[0]).toBe("https://api.github.com/applications/client/token");
  expect(revocation[1]).toMatchObject({ method: "DELETE", headers: { Authorization: `Basic ${Buffer.from("client:secret").toString("base64")}` } });
});

it("reports unconfigured status without accessing the database", async () => {
  const missing = new GitHubService({ env: {}, database: () => { throw new Error("Unexpected DB access"); } });
  expect(await missing.status("alice")).toMatchObject({ id: "github", configured: false, connected: false, enabled: false });
});

it("uses GitHub CLI with an isolated token environment and JSON stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pekka-gh-test-"));
  const captured = join(directory, "captured.json");
  const keys = ["PATH", "GH_DEBUG", "GH_HOST", "GITHUB_TOKEN"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await writeFile(join(directory, "gh"), `#!${process.execPath}\nconst fs = require("node:fs");\nlet input = "";\nprocess.stdin.on("data", chunk => input += chunk);\nprocess.stdin.on("end", () => {\n fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ args: process.argv.slice(2), input, token: process.env.GH_TOKEN, debug: process.env.GH_DEBUG, host: process.env.GH_HOST, inherited: process.env.GITHUB_TOKEN, config: process.env.GH_CONFIG_DIR, cwd: process.cwd() }));\n process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{"number":7}');\n});\n`, { mode: 0o755 });
    process.env.PATH = directory;
    process.env.GH_DEBUG = "api";
    process.env.GH_HOST = "evil.example";
    process.env.GITHUB_TOKEN = "another-account-token";
    const response = await githubCliApi("test-account-token", "/repos/o/r/issues", "POST", { title: "test issue" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ number: 7 });
    const record = JSON.parse(await readFile(captured, "utf8"));
    expect(record.args).toContain("api");
    expect(record.args).toContain("/repos/o/r/issues");
    expect(record.args).toContain("--input");
    expect(record.args.join(" ")).not.toContain("test-account-token");
    expect(record.input).toBe(JSON.stringify({ title: "test issue" }));
    expect(record.token).toBe("test-account-token");
    expect(record.debug).toBeUndefined();
    expect(record.host).toBeUndefined();
    expect(record.inherited).toBeUndefined();
    expect(basename(record.config)).toBe(basename(record.cwd));
    expect(basename(record.config)).toMatch(/^pekka-github-/);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
