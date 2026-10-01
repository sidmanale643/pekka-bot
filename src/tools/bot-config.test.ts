import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAgent } from "../agent/loop.ts";
import { createBot, findBotById } from "../bots.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import type { ChatMessage, Model } from "../model/model.ts";
import { updateBotConfig } from "./bot-config.ts";

// These tests cover approval review, which is off by default.
beforeEach(() => { vi.stubEnv("PEKKA_REQUIRE_APPROVAL", "true"); });
afterEach(() => { vi.unstubAllEnvs(); });

const database = createSqliteDatabase();
afterAll(() => database.close());
afterEach(async () => { await database.run("DELETE FROM bot_profiles"); });
const computer = new FakeComputer();

it("saves approved configuration and loads it with conversation on the next run", async () => {
  const bot = await createBot("alice", { name: "Scout", role: "Help me research", job: "" }, database);
  const context = { bot, userId: "alice", computer, database, approveAction: async () => true };
  await updateBotConfig.run({ instructions: "Track RAG papers; keep summaries short." }, context);
  const stored = await findBotById("alice", bot.id, database);
  expect(stored).toEqual({ ...bot, name: "Scout", role: "Help me research", job: "Track RAG papers; keep summaries short." });
  const conversation = [{ role: "assistant" as const, content: "What topics should I follow?" }, { role: "user" as const, content: "RAG papers" }];
  let received: ChatMessage[] = [];
  const model: Model = { async reply(messages) {
    received = messages;
    return { message: { role: "assistant", content: "What format do you prefer?" }, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } };
  } };
  await runAgent("Brief bullet points", { model, computer, database, bot: stored, userId: "alice", tools: [updateBotConfig], maxSteps: 1, conversation });
  expect(received[0]!.content).toContain("Track RAG papers; keep summaries short.");
  expect(received.slice(1)).toEqual([...conversation, { role: "user", content: "Brief bullet points" }, { role: "assistant", content: "What format do you prefer?" }]);
});

it("leaves configuration untouched after denial and rejects cross-user updates", async () => {
  const bot = await createBot("alice", { name: "Scout", role: "Research", job: "" }, database);
  const context = { bot, userId: "alice", computer, database, approveAction: async () => false };
  await expect(updateBotConfig.run({ description: "Changed" }, context)).rejects.toThrow("denied");
  await expect(updateBotConfig.run({ description: "Changed" }, { ...context, userId: "bob", approveAction: async () => true })).rejects.toThrow("not owned");
  expect(await findBotById("alice", bot.id, database)).toEqual(bot);
});
