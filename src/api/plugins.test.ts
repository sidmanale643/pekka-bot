import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiServer } from "./server.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { NotionService } from "../plugins/notion.ts";
import { LOCAL_USER } from "../database/database.ts";

let server: Server;
let database: ReturnType<typeof createSqliteDatabase>;
let base: string;
let notion: NotionService;
let env: NodeJS.ProcessEnv;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
  database = createSqliteDatabase();
  env = { NOTION_CLIENT_ID: "client", NOTION_CLIENT_SECRET: "secret", PEKKA_PLUGIN_KEY: "ab".repeat(32) };
  upstream = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    access_token: "private-access", refresh_token: "private-refresh", workspace_name: "My workspace",
  }));
  notion = new NotionService({ database: () => database, env, fetch: upstream });
  server = createApiServer({ database, notion });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env.NOTION_REDIRECT_URI = `${base}/api/plugins/notion/callback`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
});

async function begin() {
  const response = await fetch(`${base}/api/plugins/notion/connect`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  expect(response.status).toBe(200);
  const { url } = await response.json() as { url: string };
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { state: new URL(url).searchParams.get("state")!, cookie };
}

function callback(state: string, cookie: string, query = "code=code") {
  return fetch(`${base}/api/plugins/notion/callback?state=${state}&${query}`, { headers: { cookie }, redirect: "manual" });
}

it("binds OAuth to the browser, consumes state once, encrypts tokens and requires explicit access", async () => {
  const { state, cookie } = await begin();
  expect((await callback(state, "")).headers.get("location")).toContain("notion=error");
  expect(upstream).not.toHaveBeenCalled();
  expect((await callback(state, cookie)).headers.get("location")).toContain("notion=connected");
  expect((await callback(state, cookie)).headers.get("location")).toContain("notion=error");
  expect(upstream).toHaveBeenCalledTimes(1);
  const status = await notion.status(LOCAL_USER);
  expect(status).toMatchObject({ connected: true, enabled: false, workspaceName: "My workspace" });
  expect(JSON.stringify(status)).not.toContain("private-");
  const stored = await database.query("SELECT * FROM plugin_accounts");
  expect(JSON.stringify(stored)).not.toContain("private-");
  await expect(notion.request(LOCAL_USER, "/search", "POST", {})).rejects.toThrow();
  expect(upstream).toHaveBeenCalledTimes(1);
  const enabled = await fetch(`${base}/api/plugins/notion`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"enabled":true}',
  });
  expect(enabled.status).toBe(200);
  await notion.request(LOCAL_USER, "/search", "POST", {});
  expect(upstream).toHaveBeenCalledTimes(2);
  await notion.setEnabled(LOCAL_USER, false);
  await expect(notion.request(LOCAL_USER, "/search", "POST", {})).rejects.toThrow();
  expect(upstream).toHaveBeenCalledTimes(2);
});

it("handles declined consent without a token exchange", async () => {
  const { state, cookie } = await begin();
  expect((await callback(state, cookie, "error=access_denied")).headers.get("location")).toContain("notion=denied");
  expect(upstream).not.toHaveBeenCalled();
  expect((await notion.status(LOCAL_USER)).connected).toBe(false);
});

it("rejects cross-origin connect requests and mismatched callback hosts", async () => {
  const response = await fetch(`${base}/api/plugins/notion/connect`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com" }, body: "{}",
  });
  expect(response.status).toBe(403);
  env.NOTION_REDIRECT_URI = "http://localhost:3000/api/plugins/notion/callback";
  expect((await fetch(`${base}/api/plugins/notion/connect`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })).status).toBe(400);
});

it("disconnect invalidates pending OAuth attempts and deletes credentials after revocation", async () => {
  const first = await begin();
  await callback(first.state, first.cookie);
  await notion.setEnabled(LOCAL_USER, true);
  const pending = await begin();
  expect((await fetch(`${base}/api/plugins/notion`, { method: "DELETE" })).status).toBe(200);
  expect((await notion.status(LOCAL_USER)).connected).toBe(false);
  expect((await callback(pending.state, pending.cookie)).headers.get("location")).toContain("notion=error");
  await expect(notion.request(LOCAL_USER, "/search", "POST", {})).rejects.toThrow();
  expect(upstream).toHaveBeenCalledTimes(2);
});

it("keeps access disabled when remote revocation fails", async () => {
  const { state, cookie } = await begin();
  await callback(state, cookie);
  await notion.setEnabled(LOCAL_USER, true);
  upstream.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
  expect((await fetch(`${base}/api/plugins/notion`, { method: "DELETE" })).status).toBeGreaterThanOrEqual(400);
  expect(await notion.status(LOCAL_USER)).toMatchObject({ connected: true, enabled: false });
  await expect(notion.request(LOCAL_USER, "/search", "POST", {})).rejects.toThrow();
});

it("refreshes expired tokens once and persists the rotated credentials", async () => {
  const { state, cookie } = await begin();
  await callback(state, cookie);
  await notion.setEnabled(LOCAL_USER, true);
  upstream.mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh" }))
    .mockResolvedValueOnce(Response.json({ results: [] }));
  expect(await notion.request(LOCAL_USER, "/search", "POST", {})).toEqual({ results: [] });
  const refreshCall = upstream.mock.calls[2]!;
  expect(JSON.parse(refreshCall[1]!.body as string)).toEqual({ grant_type: "refresh_token", refresh_token: "private-refresh" });
  expect(upstream.mock.calls[3]![1]!.headers).toMatchObject({ Authorization: "Bearer rotated-access" });
  await notion.request(LOCAL_USER, "/search", "POST", {});
  expect(upstream.mock.calls[4]![1]!.headers).toMatchObject({ Authorization: "Bearer rotated-access" });
  expect(JSON.stringify(await database.query("SELECT * FROM plugin_accounts"))).not.toContain("rotated-");
});

it("shows setup without database access and rejects OAuth state after expiry", async () => {
  const unconfigured = new NotionService({ env: {}, database: () => { throw new Error("Must not access DB"); } });
  expect(await unconfigured.status(LOCAL_USER)).toMatchObject({ configured: false, connected: false });
  const { state, cookie } = await begin();
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
  try {
    expect((await callback(state, cookie)).headers.get("location")).toContain("notion=error");
    expect(upstream).not.toHaveBeenCalled();
  } finally { now.mockRestore(); }
});

it("disabling access blocks queued calls without waiting for an in-flight request", async () => {
  const { state, cookie } = await begin();
  await callback(state, cookie);
  await notion.setEnabled(LOCAL_USER, true);
  let finish!: (value: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  upstream.mockImplementationOnce(async () => {
    started();
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  const first = notion.request(LOCAL_USER, "/search", "POST", {});
  await entered;
  const queued = notion.request(LOCAL_USER, "/search", "POST", {}).then(() => "allowed", () => "blocked");
  try {
    await notion.setEnabled(LOCAL_USER, false);
    expect((await notion.status(LOCAL_USER)).enabled).toBe(false);
  } finally { finish(Response.json({ results: [] })); }
  await first;
  expect(await queued).toBe("blocked");
  expect(upstream).toHaveBeenCalledTimes(2);
});

it("preserves rotated tokens if access is disabled during refresh, without retrying the data request", async () => {
  const { state, cookie } = await begin();
  await callback(state, cookie);
  await notion.setEnabled(LOCAL_USER, true);
  let finish!: (value: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  upstream.mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockImplementationOnce(async () => {
      started();
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
  const request = notion.request(LOCAL_USER, "/search", "POST", {}).then(() => "allowed", () => "blocked");
  await entered;
  await notion.setEnabled(LOCAL_USER, false);
  finish(Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh" }));
  expect(await request).toBe("blocked");
  expect(upstream).toHaveBeenCalledTimes(3);
  await notion.setEnabled(LOCAL_USER, true);
  await notion.request(LOCAL_USER, "/search", "POST", {});
  expect(upstream.mock.calls[3]![1]!.headers).toMatchObject({ Authorization: "Bearer rotated-access" });
});

it("removes credentials when Notion reports the token is already revoked, but not on other failures", async () => {
  const { state, cookie } = await begin();
  await callback(state, cookie);
  upstream.mockResolvedValueOnce(Response.json({ object: "error", code: "invalid_client", message: "Bad client" }, { status: 401 }));
  expect((await fetch(`${base}/api/plugins/notion`, { method: "DELETE" })).status).toBeGreaterThanOrEqual(400);
  expect((await notion.status(LOCAL_USER)).connected).toBe(true);
  upstream.mockResolvedValueOnce(Response.json({ object: "error", code: "invalid_grant", message: "Token revoked" }, { status: 400 }));
  expect((await fetch(`${base}/api/plugins/notion`, { method: "DELETE" })).status).toBe(200);
  expect((await notion.status(LOCAL_USER)).connected).toBe(false);
});

it("surfaces Notion's error code and message to callers", async () => {
  const { state, cookie } = await begin();
  await callback(state, cookie);
  await notion.setEnabled(LOCAL_USER, true);
  upstream.mockResolvedValueOnce(Response.json({ object: "error", code: "object_not_found", message: "Could not find page." }, { status: 404 }));
  await expect(notion.request(LOCAL_USER, "/search", "POST", {})).rejects.toThrow("HTTP 404 object_not_found: Could not find page.");
  upstream.mockResolvedValueOnce(new Response("not json", { status: 502 }));
  await expect(notion.request(LOCAL_USER, "/search", "POST", {})).rejects.toThrow("(HTTP 502)");
});
