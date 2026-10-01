import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadAuthConfig } from "../auth.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { GitHubService, type GitHubApi } from "../plugins/github.ts";
import { createSession, signIn } from "../users.ts";
import { createApiServer } from "./server.ts";

let server: Server;
let database: ReturnType<typeof createSqliteDatabase>;
let base: string;
let github: GitHubService;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
let api: ReturnType<typeof vi.fn<GitHubApi>>;
let env: NodeJS.ProcessEnv;
let owner: { id: string; cookie: string };
let other: { id: string; cookie: string };

beforeEach(async () => {
  database = createSqliteDatabase();
  upstream = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ access_token: "private-access" }));
  api = vi.fn<GitHubApi>().mockImplementation(async () => Response.json({ login: "octocat" }));
  env = { GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret", PEKKA_PLUGIN_KEY: "ab".repeat(32) };
  github = new GitHubService({ database: () => database, env, fetch: upstream, api });
  const auth = loadAuthConfig({ PEKKA_URL: "http://127.0.0.1:1", GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "secret", PEKKA_ALLOWED_EMAILS: "@example.com" })!;
  server = createApiServer({ database, auth, github });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(auth, { origin: base, host: new URL(base).host, redirectUri: `${base}/api/auth/google/callback` });
  env.GITHUB_REDIRECT_URI = `${base}/api/plugins/github/callback`;
  const session = async (name: string) => {
    const user = await signIn({ sub: name, email: `${name}@example.com`, name }, undefined, database);
    return { id: user.id, cookie: `pekka_session=${await createSession(user.id, database)}` };
  };
  owner = await session("owner");
  other = await session("other");
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
});

function call(path: string, cookie = owner.cookie, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json", Origin: base, cookie, ...init.headers } });
}

async function begin() {
  const response = await call("/api/plugins/github/connect", owner.cookie, { method: "POST", body: "{}" });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax; Path=\/api\/plugins\/github/);
  const url = new URL((await response.json() as { url: string }).url);
  return { state: url.searchParams.get("state")!, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}

function callback(state: string, cookie: string, query = "code=code") {
  return call(`/api/plugins/github/callback?state=${state}&${query}`, cookie, { redirect: "manual" });
}

it("binds the callback to its browser and signed-in user, and consumes state once", async () => {
  const attempt = await begin();
  expect((await callback(attempt.state, owner.cookie)).headers.get("location")).toContain("github=error");
  expect((await callback(attempt.state, `${other.cookie}; ${attempt.cookie}`)).headers.get("location")).toContain("github=error");
  expect(upstream).not.toHaveBeenCalled();
  expect((await callback(attempt.state, `${owner.cookie}; ${attempt.cookie}`)).headers.get("location")).toBe("/?github=connected#plugins");
  expect((await callback(attempt.state, `${owner.cookie}; ${attempt.cookie}`)).headers.get("location")).toContain("github=error");
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(await github.status(owner.id)).toMatchObject({ connected: true, enabled: false });
  expect(await github.status(other.id)).toMatchObject({ connected: false });
  const listing = await (await call("/api/plugins")).json() as { plugins: { id: string; connected: boolean }[] };
  expect(listing.plugins.find((plugin) => plugin.id === "github")).toMatchObject({ connected: true });
});

it("handles declined consent and expired state without exchanging credentials", async () => {
  const declined = await begin();
  expect((await callback(declined.state, `${owner.cookie}; ${declined.cookie}`, "error=access_denied")).headers.get("location")).toContain("github=denied");
  const expired = await begin();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
  expect((await callback(expired.state, `${owner.cookie}; ${expired.cookie}`)).headers.get("location")).toContain("github=error");
  expect(upstream).not.toHaveBeenCalled();
});

it("invalidates pending authorization on disconnect and deletes credentials after revocation", async () => {
  const first = await begin();
  await callback(first.state, `${owner.cookie}; ${first.cookie}`);
  expect((await call("/api/plugins/github", owner.cookie, { method: "PUT", body: '{"enabled":true}' })).status).toBe(200);
  const pending = await begin();
  upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect((await call("/api/plugins/github", owner.cookie, { method: "DELETE" })).status).toBe(200);
  expect((await callback(pending.state, `${owner.cookie}; ${pending.cookie}`)).headers.get("location")).toContain("github=error");
  expect(await github.status(owner.id)).toMatchObject({ connected: false, enabled: false });
  expect(upstream).toHaveBeenCalledTimes(2);
});

it("rejects cross-origin authorization and configured callback host mismatches", async () => {
  expect((await call("/api/plugins/github/connect", owner.cookie, { method: "POST", body: "{}", headers: { Origin: "https://evil.example" } })).status).toBe(403);
  env.GITHUB_REDIRECT_URI = "http://localhost:3000/api/plugins/github/callback";
  expect((await call("/api/plugins/github/connect", owner.cookie, { method: "POST", body: "{}" })).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});

it("returns a harmless setup status when GitHub configuration is missing", async () => {
  delete env.GITHUB_CLIENT_ID;
  const listing = await (await call("/api/plugins")).json() as { plugins: { id: string; configured: boolean }[] };
  expect(listing.plugins.find((plugin) => plugin.id === "github")).toMatchObject({ configured: false });
  expect((await call("/api/plugins/github/connect", owner.cookie, { method: "POST", body: "{}" })).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
