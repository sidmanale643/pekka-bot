import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiServer } from "./server.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { TelegramService } from "../plugins/telegram.ts";
import { NotionService } from "../plugins/notion.ts";
import { createTelegramTools } from "../tools/telegram.ts";
import { defaultTools } from "../tools/index.ts";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";

const token = `123456:${"x".repeat(35)}`;
let server: Server;
let database: ReturnType<typeof createSqliteDatabase>;
let base: string;
let telegram: TelegramService;
let updates: unknown[];
let calls: { method: string; data: Record<string, unknown> }[];

beforeEach(async () => {
  database = createSqliteDatabase();
  updates = [];
  calls = [];
  const upstream = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const method = String(url).split("/").pop()!;
    const data = JSON.parse(init!.body as string) as Record<string, unknown>;
    calls.push({ method, data });
    if (method === "getMe") return Response.json({ ok: true, result: { username: "pekka_test_bot" } });
    if (method === "getUpdates") return Response.json({ ok: true, result: updates.filter((update) => (update as { update_id: number }).update_id >= Number(data.offset)) });
    if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: 7 } });
    return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
  });
  telegram = new TelegramService({ database: () => database, env: { TELEGRAM_BOT_TOKEN: token }, fetch: upstream });
  server = createApiServer({ database, telegram, notion: new NotionService({ env: {}, database: () => database }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
});

function post(path: string) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

function message(id: number, text: string, chat = { id: 42, type: "private", username: "me" }) {
  return { update_id: id, message: { date: Math.floor(Date.now() / 1000), text, chat } };
}

async function link() {
  const { url } = await (await post("/api/plugins/telegram/connect")).json() as { url: string };
  expect(url).toMatch(/^https:\/\/t\.me\/pekka_test_bot\?start=[a-f\d]{32}$/);
  return new URL(url).searchParams.get("start")!;
}

it("links only the private chat that sends the current code, with access off until enabled", async () => {
  const code = await link();
  expect(await (await post("/api/plugins/telegram/check")).json()).toMatchObject({ linked: false, linking: true });
  updates.push(message(1, "/start wrong"), message(2, `/start ${code}`, { id: 9, type: "group", username: "group" }), message(3, `/start ${code}`));
  expect(await (await post("/api/plugins/telegram/check")).json()).toMatchObject({ linked: true, connected: true, enabled: false, workspaceName: "@me", linking: false });
  expect(calls.at(-1)).toMatchObject({ method: "sendMessage", data: { chat_id: 42 } });
  expect((await post("/api/plugins/telegram/check")).status).toBe(400);
  await link();
  await post("/api/plugins/telegram/check");
  expect(calls.filter((call) => call.method === "getUpdates").at(-1)!.data.offset).toBe(4);
  const plugins = await (await fetch(`${base}/api/plugins`)).json() as { plugins: { id: string }[] };
  expect(plugins.plugins.map((plugin) => plugin.id)).toEqual(["wispr", "notion", "gmail", "calendar", "drive", "contacts", "telegram", "github", "linear", "granola", /* "retell", Retell AI */ "bland", "todoist"]);
  expect(JSON.stringify(plugins)).not.toContain(token);
});

it("sends tool messages to the linked chat only while enabled, and stops after disconnect", async () => {
  const tools = createTelegramTools(telegram);
  expect(defaultTools.filter((tool) => tool.name.startsWith("telegram_")).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
  const context = { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER, bot: { name: "Scout" } as never };
  const call = { id: "1", type: "function" as const, function: { name: "telegram_send_message", arguments: JSON.stringify({ text: "Done" }) } };
  expect((await executeToolCall(call, tools, context)).isError).toBe(true);
  const code = await link();
  updates.push(message(1, `/start ${code}`));
  await post("/api/plugins/telegram/check");
  expect((await executeToolCall(call, tools, context)).isError).toBe(true);
  const enabled = await fetch(`${base}/api/plugins/telegram`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"enabled":true}' });
  expect(await enabled.json()).toMatchObject({ enabled: true });
  const sends = () => calls.filter((item) => item.method === "sendMessage").length;
  const before = sends();
  expect((await executeToolCall(call, tools, context)).isError).toBe(false);
  expect(calls.at(-1)).toMatchObject({ method: "sendMessage", data: { chat_id: 42, text: "Scout:\nDone" } });
  expect(await (await fetch(`${base}/api/plugins/telegram`, { method: "DELETE" })).json()).toMatchObject({ connected: false });
  expect((await executeToolCall(call, tools, context)).isError).toBe(true);
  expect(sends()).toBe(before + 1);
});

it("reports setup without database access and keeps the token out of errors", async () => {
  const unconfigured = new TelegramService({ env: {}, database: () => { throw new Error("Must not access DB"); } });
  expect(await unconfigured.status(LOCAL_USER)).toMatchObject({ configured: false, connected: false });
  const failing = new TelegramService({ database: () => database, env: { TELEGRAM_BOT_TOKEN: token }, fetch: async () => Response.json({ ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" }, { status: 409 }) });
  const error = await failing.startLink(LOCAL_USER).catch((caught: Error) => caught);
  expect(String(error)).toContain("409: Conflict");
  expect(String(error)).not.toContain(token);
});

it("links each user's own chat, even when another user's check reads their message", async () => {
  const start = async (userId: string) => new URL((await telegram.startLink(userId)).url).searchParams.get("start")!;
  const alice = await start("alice");
  const bob = await start("bob");
  updates.push(message(1, `/start ${bob}`, { id: 7, type: "private", username: "bob" }));
  expect(await telegram.checkLink("alice")).toBe(false);
  expect(await telegram.status("bob")).toMatchObject({ connected: true, workspaceName: "@bob", linking: false });
  expect(await telegram.checkLink("bob")).toBe(true);
  updates.push(message(2, `/start ${alice}`, { id: 8, type: "private", username: "alice" }));
  expect(await telegram.checkLink("alice")).toBe(true);
  await telegram.setEnabled("alice", true);
  await telegram.send("alice", "Hi");
  expect(calls.at(-1)).toMatchObject({ method: "sendMessage", data: { chat_id: 8, text: "Hi" } });
  await expect(telegram.send("bob", "Hi")).rejects.toThrow("access is off");
});


it("cancels a pending relink without removing the existing chat or access", async () => {
  const code = await link();
  updates.push(message(1, `/start ${code}`));
  await post("/api/plugins/telegram/check");
  await telegram.setEnabled(LOCAL_USER, true);
  const cancelled = await link();
  expect(await telegram.status(LOCAL_USER)).toMatchObject({ linking: true, linkUrl: expect.stringContaining(cancelled) });
  const response = await fetch(`${base}/api/plugins/telegram/connect`, { method: "DELETE" });
  expect(await response.json()).toMatchObject({ linking: false, connected: true, enabled: true });
  updates.push(message(2, `/start ${cancelled}`, { id: 99, type: "private", username: "other" }));
  await expect(telegram.checkLink(LOCAL_USER)).rejects.toThrow("expired");
  expect(await telegram.status(LOCAL_USER)).toMatchObject({ workspaceName: "@me", enabled: true });
});

it("disconnect waits for a running link check and removes its saved connection", async () => {
  let release!: () => void;
  let started!: () => void;
  const checking = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const service = new TelegramService({ database: () => database, env: { TELEGRAM_BOT_TOKEN: token }, fetch: async (url) => {
    if (String(url).endsWith("getMe")) return Response.json({ ok: true, result: { username: "pekka_test_bot" } });
    if (String(url).endsWith("getUpdates")) {
      started();
      await blocked;
      return Response.json({ ok: true, result: updates });
    }
    return Response.json({ ok: true, result: { message_id: 1 } });
  } });
  const code = new URL((await service.startLink(LOCAL_USER)).url).searchParams.get("start")!;
  updates.push(message(1, `/start ${code}`));
  const check = service.checkLink(LOCAL_USER);
  await checking;
  const disconnect = service.disconnect(LOCAL_USER);
  release();
  await Promise.all([check, disconnect]);
  expect(await service.status(LOCAL_USER)).toMatchObject({ connected: false, linking: false, enabled: false });
});
