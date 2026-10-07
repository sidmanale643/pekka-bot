import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBot, type Bot } from "./bots.ts";
import { listMessages } from "./chat-history.ts";
import { ChatRecorder, toolCard } from "./chat-recorder.ts";
import { LOCAL_USER, type Database } from "./database/database.ts";
import { createSqliteDatabase } from "./database/sqlite.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let scout: Bot;
let writer: Bot;
const usage = { promptTokens: 2, completionTokens: 3, costUsd: 0.01 };
const chat = (bot: Bot = scout) => listMessages(LOCAL_USER, bot.id, database);
const target = () => ({ userId: LOCAL_USER, botId: scout.id, botName: scout.name, database: () => database });

beforeEach(async () => {
  database = createSqliteDatabase();
  scout = await createBot(LOCAL_USER, { name: "Scout", role: "Researcher", job: "" }, database);
  writer = await createBot(LOCAL_USER, { name: "Writer", role: "Author", job: "" }, database);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); database.close(); });

it("saves the question and a pending reply first, then the reply as it streams, then its final state", async () => {
  vi.useFakeTimers();
  const recorder = await ChatRecorder.start(target(), "File the bug", { question: "q1", reply: "a1" });
  const [question, pending] = await chat();
  expect(question).toEqual({ id: "q1", time: expect.any(Number), role: "user", text: "File the bug" });
  expect(pending).toEqual({ id: "a1", time: question!.time, role: "assistant", text: "", pending: true, status: "" });

  recorder.apply({ type: "step", step: 1 });
  recorder.apply({ type: "message_delta", text: "Looking" });
  recorder.apply({ type: "tool_call", id: "c1", name: "github_create_issue", arguments: JSON.stringify({ owner: "acme", repo: "app", title: "Bug" }) });
  const streamed = recorder.apply({ type: "tool_result", id: "c1", name: "github_create_issue", output: JSON.stringify({ html_url: "https://github.com/acme/app/issues/1" }), isError: false });
  const card = { plugin: "GitHub", title: "Bug", detail: "Opened issue · acme/app", url: "https://github.com/acme/app/issues/1" };
  // The browser gets the same card the chat saves.
  expect(streamed).toMatchObject({ type: "tool_result", card });
  expect((await chat())[1]).toMatchObject({ pending: true, text: "" });
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(async () => expect((await chat())[1]).toMatchObject({ pending: true, text: "Looking", tools: [{ name: "github_create_issue", isError: false, output: card }] }));

  // The next step's text replaces the last one's.
  recorder.apply({ type: "step", step: 2 });
  recorder.apply({ type: "message_delta", text: "Filed " });
  recorder.apply({ type: "message_delta", text: "it" });
  await recorder.finish({ status: "done", answer: "", usage });
  expect((await chat())[1]).toEqual({
    id: "a1", time: question!.time, role: "assistant", text: "Filed it", pending: false, status: "", usage,
    tools: [{ name: "github_create_issue", isError: false, output: card }],
  });
});

it("records permission decisions and how a run ended", async () => {
  const recorder = await ChatRecorder.start(target(), "Send it");
  const request = { id: "p1", runId: "r1", expiresAt: "2026-01-01T00:00:00.000Z", tool: "gmail_send", arguments: {}, reason: "Sends email" };
  recorder.apply({ type: "permission_requested", request } as never);
  recorder.apply({ type: "permission_resolved", id: "p1", approved: false });
  await recorder.finish({ status: "step_limit", answer: "", usage });
  expect((await chat())[1]).toMatchObject({ text: "Task finished without a text response.", status: "Run ended: step_limit", permissions: [{ ...request, decision: "Denied or expired" }] });

  const stopped = await ChatRecorder.start(target(), "Never mind");
  await stopped.finish({ status: "stopped", answer: "", usage });
  expect((await chat())[3]).toMatchObject({ text: "", status: "Stopped", pending: false });
});

it("saves a failed run as an error, keeping what it wrote, and marks calls that never finished as failed", async () => {
  const recorder = await ChatRecorder.start(target(), "Search");
  recorder.apply({ type: "message_delta", text: "Partial" });
  recorder.apply({ type: "tool_call", id: "c1", name: "web_search", arguments: "{}" });
  await recorder.fail("Task execution failed.");
  expect((await chat())[1]).toMatchObject({ role: "error", text: "Partial\n\nTask execution failed.", pending: false, tools: [{ name: "web_search", isError: true }] });
});

it("saves a delegated bot's brief and reply in that bot's chat, under the IDs it streams", async () => {
  const recorder = await ChatRecorder.start(target(), "Get Writer to draft it");
  const bot = { id: writer.id, name: writer.name };
  const started = recorder.apply({ type: "delegation_start", bot, task: "Draft the post" });
  expect(started).toMatchObject({ messages: { question: expect.any(String), reply: expect.any(String) } });
  const { messages: ids } = started as { messages: { question: string; reply: string } };
  recorder.apply({ type: "delegation_event", bot, event: { type: "tool_call", id: "c1", name: "write_file", arguments: JSON.stringify({ path: "post.md" }) } });
  const result = recorder.apply({ type: "delegation_event", bot, event: { type: "tool_result", id: "c1", name: "write_file", output: "ok", isError: false } });
  expect(result).toMatchObject({ event: { card: { plugin: "Sandbox", title: "post.md" } } });
  recorder.apply({ type: "delegation_end", bot, status: "done", answer: "Draft ready" });
  await recorder.finish({ status: "done", answer: "Writer drafted it", usage });

  const [brief, reply] = await chat(writer);
  expect(brief).toEqual({ id: ids.question, time: expect.any(Number), role: "user", text: "Draft the post", from: "Scout" });
  expect(reply).toMatchObject({ id: ids.reply, role: "assistant", text: "Draft ready", pending: false, status: "", tools: [{ name: "write_file", isError: false }] });
  expect((await chat()).map((message) => message.text)).toEqual(["Get Writer to draft it", "Writer drafted it"]);
});

it("ends a delegated reply that never reported back as failed when its run ends", async () => {
  const recorder = await ChatRecorder.start(target(), "Delegate");
  recorder.apply({ type: "delegation_start", bot: { id: writer.id, name: writer.name }, task: "Draft" });
  await recorder.fail("Task execution failed.");
  expect((await chat(writer))[1]).toMatchObject({ pending: false, status: "Failed" });
});

it("doesn't start when the question can't be saved, and logs a later failed save without failing the run", async () => {
  const broken: Database = { query: database.query.bind(database), run: async () => { throw new Error("D1 is down"); } };
  await expect(ChatRecorder.start({ ...target(), database: () => broken }, "Hello")).rejects.toThrow("D1 is down");

  let fail = false;
  const flaky: Database = { query: database.query.bind(database), run: (sql, params) => fail ? Promise.reject(new Error("D1 is down")) : database.run(sql, params) };
  const recorder = await ChatRecorder.start({ ...target(), database: () => flaky }, "Hello");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  fail = true;
  await expect(recorder.finish({ status: "done", answer: "Hi", usage })).resolves.toBeUndefined();
  expect(logged).toHaveBeenCalledWith("Could not save a chat message: D1 is down");
});

it("makes cards only for write tools, linking to what they made", () => {
  expect(toolCard("web_search", "{}", "[]")).toBeUndefined();
  expect(toolCard("linear_create_issue", JSON.stringify({ title: "Fix login" }), JSON.stringify({ issueCreate: { issue: { url: "https://linear.app/acme/issue/ENG-1" } } })))
    .toEqual({ plugin: "Linear", title: "Fix login", detail: "Created issue", url: "https://linear.app/acme/issue/ENG-1" });
  expect(toolCard("gmail_send", JSON.stringify({ subject: "Hi", to: ["a@example.com", "b@example.com"] }), "not json"))
    .toEqual({ plugin: "Gmail", title: "Hi", detail: "Sent email · a@example.com, b@example.com" });
  expect(toolCard("delegate_task", JSON.stringify({ bot_name: "Writer" }), "{}")).toEqual({ plugin: "Team", title: "Writer", detail: "Delegated task", bot: "Writer" });
  // Only https links become clickable.
  expect(toolCard("notion_create_page", JSON.stringify({ title: "Notes" }), JSON.stringify({ url: "javascript:alert(1)" }))).not.toHaveProperty("url");
});
