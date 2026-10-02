import { afterAll, afterEach, expect, it } from "vitest";
import type { AgentEvent, EventHandler } from "../agent/events.ts";
import { runAgent, type AgentResult } from "../agent/loop.ts";
import { systemPrompt } from "../agent/system-prompt.ts";
import { CHIEF_OF_STAFF, createBot, deleteBot, ensureChiefOfStaff, findBot, listBots, updateBot } from "../bots.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import type { Model, Usage } from "../model/model.ts";
import { delegateFor, type RunOwner } from "../runtime.ts";
import { createTeammate, delegateTask, listTeam, updateTeammate } from "./chief-of-staff.ts";
import type { ToolContext } from "./tool.ts";

const database = createSqliteDatabase();
afterAll(() => database.close());
afterEach(async () => { await database.run("DELETE FROM bot_profiles"); });
const computer = new FakeComputer();
const usage = (costUsd: number): Usage => ({ promptTokens: 10, completionTokens: 5, cachedTokens: 0, cacheHitRate: 0, costUsd });

it("gives each user one chief of staff, listed first, that can be renamed but not deleted", async () => {
  const scout = await createBot("alice", { name: "Scout", role: "Research", job: "" }, database);
  const [chief, again] = await Promise.all([ensureChiefOfStaff("alice", database), ensureChiefOfStaff("alice", database)]);
  expect(chief).toEqual({ ...CHIEF_OF_STAFF, id: chief.id, primary: true });
  expect(again).toEqual(chief);
  expect(await listBots("alice", database)).toEqual([chief, scout]);
  expect((await ensureChiefOfStaff("bob", database)).id).not.toBe(chief.id);

  const renamed = await updateBot("alice", chief.id, { name: "Alfred", role: chief.role, job: "" }, database);
  expect(renamed).toEqual({ ...chief, name: "Alfred" });
  expect(await ensureChiefOfStaff("alice", database)).toEqual(renamed);
  await deleteBot("alice", chief.id, database);
  expect(await findBot("alice", "Alfred", database)).toEqual(renamed);
});

it("promotes a bot the user already named Chief of Staff instead of duplicating it", async () => {
  const existing = await createBot("alice", { name: "chief of staff", role: "My own", job: "Keep me posted" }, database);
  expect(await ensureChiefOfStaff("alice", database)).toEqual({ ...existing, primary: true });
  expect(await listBots("alice", database)).toHaveLength(1);
});

it("lets only the chief list, create and reconfigure the user's other bots", async () => {
  const chief = await ensureChiefOfStaff("alice", database);
  const scout = await createBot("alice", { name: "Scout", role: "Research", job: "Find papers" }, database);
  const context: ToolContext = { computer, database, userId: "alice", bot: chief };

  expect(JSON.parse(await listTeam.run({}, context))).toEqual({ bots: [
    { name: chief.name, description: chief.role, instructions: "", you: true },
    { name: "Scout", description: "Research", instructions: "Find papers" },
  ] });
  expect(JSON.parse(await createTeammate.run({ name: "Writer", description: "Drafts posts" }, context)))
    .toEqual({ name: "Writer", description: "Drafts posts", instructions: "" });
  await expect(createTeammate.run({ name: "scout", description: "Again" }, context)).rejects.toThrow("already exists");
  expect(JSON.parse(await updateTeammate.run({ name: "scout", instructions: "Only arXiv" }, context)))
    .toEqual({ name: "Scout", description: "Research", instructions: "Only arXiv" });
  await expect(updateTeammate.run({ name: chief.name, description: "Changed" }, context)).rejects.toThrow("update_bot_config");
  await expect(updateTeammate.run({ name: "Missing", description: "Changed" }, context)).rejects.toThrow("No bot named");

  // Another bot, or the same tools reached by someone else's chief, can't manage this user's bots.
  await expect(listTeam.run({}, { ...context, bot: scout })).rejects.toThrow("Only the chief of staff");
  const bobsChief = await ensureChiefOfStaff("bob", database);
  await expect(updateTeammate.run({ name: "Scout", description: "Taken over" }, { ...context, userId: "bob", bot: bobsChief })).rejects.toThrow("No bot named");
  expect((await findBot("alice", "Scout", database))?.role).toBe("Research");
});

it("delegates a brief to another bot and counts its cost toward the chief's run", async () => {
  const chief = await ensureChiefOfStaff("alice", database);
  const scout = await createBot("alice", { name: "Scout", role: "Research", job: "" }, database);
  const briefs: { bot: string; task: string }[] = [];
  const delegate = async (bot: typeof scout, task: string) => {
    briefs.push({ bot: bot.name, task });
    return { status: "done" as const, answer: "Three papers found.", steps: 2, usage: usage(0.5) };
  };
  const context: ToolContext = { computer, database, userId: "alice", bot: chief, delegate };

  await expect(delegateTask.run({ bot_name: chief.name, task: "Work" }, context)).rejects.toThrow("That is you");
  await expect(delegateTask.run({ bot_name: "Scout", task: "Work" }, { ...context, delegate: undefined })).rejects.toThrow("not available");

  let step = 0;
  const model: Model = { async reply() {
    step++;
    return step === 1
      ? { message: { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "delegate_task", arguments: JSON.stringify({ bot_name: "scout", task: "Find RAG papers from this week" }) } }] }, usage: usage(0.25) }
      : { message: { role: "assistant", content: "Scout found three papers." }, usage: usage(0.25) };
  } };
  const result = await runAgent("What's new in RAG?", { model, computer, database, userId: "alice", bot: chief, tools: [delegateTask], maxSteps: 3, delegate });
  expect(briefs).toEqual([{ bot: "Scout", task: "Find RAG papers from this week" }]);
  const toolMessage = result.messages.find((message) => message.role === "tool");
  expect(JSON.parse(toolMessage!.content)).toEqual({ bot: "Scout", status: "done", answer: "Three papers found.", steps: 2, cost_usd: 0.5 });
  expect(result.answer).toBe("Scout found three papers.");
  expect(result.usage.costUsd).toBe(1);
});

it("runs a delegation as the other bot with the chief's reviewer, one at a time per bot, reporting it live", async () => {
  const scout = await createBot("alice", { name: "Scout", role: "Research", job: "" }, database);
  const approveAction = async () => true;
  const owners: RunOwner[] = [];
  const events: AgentEvent[] = [];
  let finish!: () => void;
  const execute = async (task: string, owner: RunOwner, onEvent?: EventHandler): Promise<AgentResult> => {
    owners.push(owner);
    onEvent?.({ type: "tool_call", name: "web_search", arguments: "{}" });
    await new Promise<void>((resolve) => { finish = resolve; });
    if (task === "Fail") throw new Error("Sandbox unavailable");
    return { status: "done", answer: "Done", steps: 1, usage: usage(0), messages: [] };
  };
  const busy = new Set<string>();
  const reserve = (bot: typeof scout) => busy.has(bot.id) ? undefined : (busy.add(bot.id), () => { busy.delete(bot.id); });
  const delegate = delegateFor({ userId: "alice", approveAction, reserve }, (event) => events.push(event), execute);

  const first = delegate(scout, "Find papers");
  await expect(delegate(scout, "Find more")).rejects.toThrow("Scout is busy");
  finish();
  expect(await first).toEqual({ status: "done", answer: "Done", steps: 1, usage: usage(0) });
  expect(owners).toEqual([{ userId: "alice", bot: scout, approveAction }]);
  expect(busy.size).toBe(0);
  const who = { id: scout.id, name: "Scout" };
  expect(events).toEqual([
    { type: "delegation_start", bot: who, task: "Find papers" },
    { type: "delegation_event", bot: who, event: { type: "tool_call", name: "web_search", arguments: "{}" } },
    { type: "delegation_end", bot: who, status: "done", answer: "Done" },
  ]);

  // A run that fails still ends the live view and frees the bot.
  events.length = 0;
  const failing = delegate(scout, "Fail");
  finish();
  await expect(failing).rejects.toThrow("Sandbox unavailable");
  expect(events.at(-1)).toEqual({ type: "delegation_end", bot: who, status: "failed", answer: "" });
  expect(busy.size).toBe(0);
});

it("gives only the chief of staff the instructions for running other bots", async () => {
  const chief = await ensureChiefOfStaff("alice", database);
  const scout = await createBot("alice", { name: "Scout", role: "Research", job: "" }, database);
  expect(systemPrompt(chief, 30)).toContain("You are the user's chief of staff");
  expect(systemPrompt(scout, 30)).not.toContain("delegate_task");
  expect(systemPrompt(undefined, 30)).not.toContain("delegate_task");
});
