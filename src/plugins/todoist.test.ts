import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { TodoistService } from "./todoist.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let service: TodoistService;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
const forms = () => upstream.mock.calls.filter(([url]) => String(url).endsWith("/access_token")).map(([, init]) => Object.fromEntries(new URLSearchParams(init!.body as string)));
const rpcCalls = () => upstream.mock.calls.filter(([url, init]) => String(url).endsWith("/mcp") && init?.body).map(([, init]) => JSON.parse(init!.body as string));

beforeEach(() => {
  database = createSqliteDatabase();
  upstream = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith("/register")) return Response.json({ client_id: "pekka-client" });
    if (String(url).endsWith("/access_token")) {
      const refresh = new URLSearchParams(init!.body as string).get("grant_type") === "refresh_token";
      return Response.json({ access_token: refresh ? "private-refreshed" : "private-access", token_type: "Bearer", expires_in: 3600, ...(!refresh ? { refresh_token: "private-refresh" } : {}) });
    }
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(init!.body as string);
    if (!('id' in message)) return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "todoist-test", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "search_notes", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } }, { name: "delete_note", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }] }
      : { content: [{ type: "text", text: "Meeting summary" }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
  service = new TodoistService({ database: () => database, fetch: upstream, env: { PEKKA_PLUGIN_KEY: "ab".repeat(32) } });
});
afterEach(() => { vi.useRealTimers(); database.close(); });

async function connect() {
  await service.authorize("state");
  await service.exchange("alice", "code", "state");
  await service.setEnabled("alice", true);
}

it("registers a public client, uses PKCE and encrypts a disabled connection", async () => {
  const url = new URL(await service.authorize("state"));
  expect(url.origin + url.pathname).toBe("https://todoist.com/oauth/authorize");
  expect(url.searchParams.get("resource")).toBe("https://ai.todoist.net/mcp");
  await service.exchange("alice", "code", "state");
  expect(createHash("sha256").update(forms()[0]!.code_verifier!).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
  expect(await service.status("alice")).toMatchObject({ connected: true, enabled: false });
  expect(JSON.stringify(await database.query("SELECT * FROM plugin_accounts"))).not.toContain("private-");
  await expect(service.request("alice")).rejects.toThrow("access is off");
  expect(rpcCalls()).toHaveLength(0);
});

it("uses the SDK to initialize, discover schemas and call only a listed read tool", async () => {
  await connect();
  expect(await service.request("alice")).toMatchObject({ tools: [{ name: "search_notes" }, { name: "delete_note" }] });
  const result = await service.request("alice", "search_notes", { query: "pricing" });
  expect(result).toMatchObject({ content: [{ text: "Meeting summary" }] });
  expect(rpcCalls().find((call) => call.method === "tools/call").params).toEqual({ name: "search_notes", arguments: { query: "pricing" } });
  await expect(service.request("alice", "delete_note")).rejects.toThrow("not explicitly read-only");
  await expect(service.request("alice", "invented")).rejects.toThrow("Choose a tool");
  await service.request("alice", "delete_note", {}, undefined, false);
  expect(rpcCalls().filter((call) => call.method === "tools/call")).toHaveLength(2);
});

it("isolates users and stops requests after disable or disconnect", async () => {
  await connect();
  await expect(service.request("bob")).rejects.toThrow("access is off");
  await expect(service.setEnabled("bob", true)).rejects.toThrow("Connect Todoist");
  await service.setEnabled("alice", false);
  await expect(service.request("alice")).rejects.toThrow("access is off");
  await service.setEnabled("alice", true);
  await service.disconnect("alice");
  await expect(service.request("alice")).rejects.toThrow("access is off");
  expect(await service.status("alice")).toMatchObject({ connected: false, enabled: false });
  expect(rpcCalls()).toHaveLength(0);
});

it("refreshes expired credentials and preserves a refresh token when omitted", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await connect();
  vi.setSystemTime(Date.now() + 3600_000);
  await service.request("alice");
  vi.setSystemTime(Date.now() + 3600_000);
  await service.request("alice");
  expect(forms().slice(1)).toEqual(Array(2).fill({ client_id: "pekka-client", resource: "https://ai.todoist.net/mcp", grant_type: "refresh_token", refresh_token: "private-refresh" }));
  const headers = upstream.mock.calls.filter(([url]) => String(url).endsWith("/mcp")).map(([, init]) => new Headers(init?.headers).get("authorization"));
  expect(headers.every((header) => header === "Bearer private-refreshed")).toBe(true);
});

it("does not send credentials through redirects and reports upstream errors without tokens", async () => {
  await connect();
  upstream.mockImplementationOnce(async (_url, init) => {
    expect(init?.redirect).toBe("error");
    throw new Error("private-access");
  });
  await expect(service.request("alice")).rejects.toThrow("Todoist request failed");
});

it("stops a tool call when access is disabled during discovery", async () => {
  await connect();
  const original = upstream.getMockImplementation()!;
  upstream.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (String(init?.body).includes('"tools/list"')) await service.setEnabled("alice", false);
    return response;
  });
  await expect(service.request("alice", "search_notes")).rejects.toThrow("access is off");
  expect(rpcCalls().filter((call) => call.method === "tools/call")).toHaveLength(0);
});

it("connects through Pekka's OAuth routes with cookie binding and one-time state", async () => {
  const { createApiServer } = await import("../api/server.ts");
  const { LOCAL_USER } = await import("../database/database.ts");
  const env: NodeJS.ProcessEnv = { PEKKA_PLUGIN_KEY: "ab".repeat(32) };
  const todoist = new TodoistService({ database: () => database, fetch: upstream, env });
  const server = createApiServer({ database, todoist, auth: null });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  env.TODOIST_REDIRECT_URI = `${base}/api/plugins/todoist/callback`;
  try {
    const begin = await fetch(`${base}/api/plugins/todoist/connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(begin.status).toBe(200);
    const { url } = await begin.json() as { url: string };
    const state = new URL(url).searchParams.get("state")!;
    const cookie = begin.headers.get("set-cookie")!.split(";")[0]!;
    const callback = `${base}/api/plugins/todoist/callback?state=${state}&code=code`;
    expect((await fetch(callback, { redirect: "manual" })).headers.get("location")).toContain("todoist=error");
    expect(forms()).toHaveLength(0);
    expect((await fetch(callback, { headers: { cookie }, redirect: "manual" })).headers.get("location")).toContain("todoist=connected");
    expect((await fetch(callback, { headers: { cookie }, redirect: "manual" })).headers.get("location")).toContain("todoist=error");
    expect(forms()).toHaveLength(1);
    expect(await todoist.status(LOCAL_USER)).toMatchObject({ connected: true, enabled: false });
    const enable = await fetch(`${base}/api/plugins/todoist`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"enabled":true}' });
    expect(await enable.json()).toMatchObject({ enabled: true });
    expect((await fetch(`${base}/api/plugins/todoist`, { method: "DELETE" })).status).toBe(200);
    expect(await todoist.status(LOCAL_USER)).toMatchObject({ connected: false });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("requires old API-token connections to reconnect with OAuth", async () => {
  const { ApiKeyPlugin } = await import("./api-key.ts");
  const old = new ApiKeyPlugin({ id: "todoist", name: "Todoist", baseUrl: "https://example.com", database: () => database, env: { PEKKA_PLUGIN_KEY: "ab".repeat(32) }, fetch: async () => Response.json({}), check: async () => "old account" });
  await old.connect("alice", "old-private-token");
  expect(await service.status("alice")).toMatchObject({ connected: false, enabled: false });
  await expect(service.request("alice")).rejects.toThrow("Cannot unlock");
  expect(upstream).not.toHaveBeenCalled();
});
