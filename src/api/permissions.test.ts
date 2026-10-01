import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import type { PermissionRequest } from "../permissions/manager.ts";
import { writeFile } from "../tools/write-file.ts";
import { createApiServer } from "./server.ts";

// These tests cover approval review, which is off by default.
beforeEach(() => { vi.stubEnv("PEKKA_REQUIRE_APPROVAL", "true"); });
afterEach(() => { vi.unstubAllEnvs(); });

let server: Server;

afterEach(async () => {
  if (!server?.listening) return;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
});

async function start() {
  const computer = new FakeComputer();
  server = createApiServer({ auth: null, execute: async (_task, owner) => {
    const result = await executeToolCall({ id: "call", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "file", content: "approved" }) } }, [writeFile], { computer, ...owner });
    return { status: "done", answer: result.output, steps: 1, usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheHitRate: null, costUsd: 0 }, messages: [] };
  } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, data: unknown, streaming = false) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(streaming ? { Accept: "text/event-stream" } : {}) }, body: JSON.stringify(data) });
  const pending = async () => (await (await fetch(`${base}/api/permissions`)).json() as { requests: PermissionRequest[] }).requests;
  return { computer, post, pending };
}

it.each([true, false])("enforces a one-time HTTP decision before running the tool (approved=%s)", async (approved) => {
  const { computer, post, pending } = await start();
  const response = await post("/api/runs", { task: "Write file" }, true);
  await vi.waitFor(async () => expect(await pending()).toHaveLength(1));
  const request = (await pending())[0]!;
  expect(computer.files.size).toBe(0);
  expect(request).toMatchObject({ tool: "write_file", arguments: { path: "file", content: "approved" } });
  expect((await post(`/api/permissions/${request.id}`, { approved })).status).toBe(200);
  const stream = await response.text();
  expect(stream).toContain("event: permission_requested");
  expect(stream).toContain("event: permission_resolved");
  expect(computer.files.has("file")).toBe(approved);
  expect((await post(`/api/permissions/${request.id}`, { approved: true })).status).toBe(404);
  expect(await pending()).toEqual([]);
});

it("rejects writes in non-streaming runs and cancels approvals on browser disconnect", async () => {
  const { computer, post, pending } = await start();
  const response = await post("/api/runs", { task: "Write file" });
  expect((await response.json() as { answer: string }).answer).toContain("Permission required");
  expect(computer.files.size).toBe(0);
  const stream = await post("/api/runs", { task: "Write file" }, true);
  await vi.waitFor(async () => expect(await pending()).toHaveLength(1));
  const id = (await pending())[0]!.id;
  await stream.body!.cancel();
  await vi.waitFor(async () => expect(await pending()).toEqual([]));
  expect(computer.files.size).toBe(0);
  expect((await post(`/api/permissions/${id}`, { approved: true })).status).toBe(404);
});
