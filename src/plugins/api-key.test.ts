import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { createGranolaService } from "./granola.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
const env = { PEKKA_PLUGIN_KEY: "ab".repeat(32) };

beforeEach(() => {
  database = createSqliteDatabase();
  upstream = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).endsWith("/user")) return Response.json({ email: "ada@example.com", full_name: "Ada" });
    if (String(url).includes("/v1/notes")) return Response.json({ notes: [{ owner: { name: "Ada", email: "ada@example.com" } }], hasMore: false, cursor: null });
    return Response.json({ results: [], next_cursor: null });
  });
});

afterEach(() => { database.close(); });

it("checks a pasted key, stores it sealed and sends it as a bearer token", async () => {
  const granola = createGranolaService({ database: () => database, env, fetch: upstream });
  await granola.connect("alice", "private-token-123");
  expect(String(upstream.mock.calls[0]![0])).toBe("https://public-api.granola.ai/v1/notes?page_size=1");
  expect(await granola.status("alice")).toMatchObject({ id: "granola", configured: true, connected: true, enabled: true, workspaceName: "ada@example.com" });
  expect(JSON.stringify(await database.query("SELECT * FROM plugin_accounts"))).not.toContain("private-token");
  await granola.request("alice", "/tasks?limit=5");
  expect(upstream.mock.calls[1]![1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer private-token-123" } });
  await granola.request("alice", "/tasks", { method: "POST", body: { content: "Buy milk" } });
  expect(upstream.mock.calls[2]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ content: "Buy milk" }) });
});

it("refuses requests while access is off or no key is saved, and forgets the key on disconnect", async () => {
  const granola = createGranolaService({ database: () => database, env, fetch: upstream });
  await expect(granola.request("alice", "/v1/notes")).rejects.toThrow("access is off");
  await expect(granola.setEnabled("alice", true)).rejects.toThrow("Add your Granola API key");
  await granola.connect("alice", "grn_private-key");
  expect(await granola.status("alice")).toMatchObject({ workspaceName: "ada@example.com" });
  expect(await granola.status("bob")).toMatchObject({ connected: false });
  await granola.setEnabled("alice", false);
  await expect(granola.request("alice", "/v1/notes")).rejects.toThrow("access is off");
  await granola.setEnabled("alice", true);
  await granola.request("alice", "/v1/notes");
  await granola.disconnect("alice");
  expect(await granola.status("alice")).toMatchObject({ connected: false, enabled: false });
});

it("doesn't save a key the service rejects, and explains failed requests", async () => {
  const granola = createGranolaService({ database: () => database, env, fetch: upstream });
  upstream.mockResolvedValueOnce(new Response("Forbidden", { status: 401 }));
  await expect(granola.connect("alice", "wrong-token")).rejects.toThrow("rejected the API key");
  expect(await granola.status("alice")).toMatchObject({ connected: false });
  await granola.connect("alice", "private-token-123");
  upstream.mockResolvedValueOnce(new Response("Task not found", { status: 404 }));
  await expect(granola.request("alice", "/tasks/x")).rejects.toThrow("HTTP 404: Task not found");
  upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
  await expect(granola.request("alice", "/tasks")).rejects.toThrow("Could not reach Granola");
  upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect(await granola.request("alice", "/tasks/x/close", { method: "POST" })).toEqual({ ok: true });
});

it("reports setup required without PEKKA_PLUGIN_KEY", async () => {
  const granola = createGranolaService({ env: {}, database: () => { throw new Error("Unexpected DB access"); } });
  expect(await granola.status("alice")).toMatchObject({ id: "granola", configured: false, connected: false });
  await expect(granola.connect("alice", "grn_key")).rejects.toThrow("PEKKA_PLUGIN_KEY");
});
