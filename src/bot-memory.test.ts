import { afterEach, beforeEach, expect, it } from "vitest";
import { runAgent } from "./agent/loop.ts";
import { BotMemory } from "./bot-memory.ts";
import { createBot, type Bot } from "./bots.ts";
import { FakeComputer } from "./computer/fake-computer.ts";
import { createSqliteDatabase } from "./database/sqlite.ts";
import { readMemory, writeMemory } from "./tools/bot-memory.ts";
import { createScheduledJob, listScheduledJobs, runScheduler } from "./scheduler.ts";
import { LOCAL_USER } from "./database/database.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let bot: Bot;
beforeEach(async () => {
  database = createSqliteDatabase();
  bot = await createBot(LOCAL_USER, { name: "Scout", role: "Researcher", job: "Research" }, database);
});
afterEach(() => { database.close(); });

it("persists agent-written Markdown across fresh runs without leaking to another bot", async () => {
  let step = 0;
  await runAgent("Remember my preferences", {
    bot, database, computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER, tools: [writeMemory], maxSteps: 2,
    model: { async reply() {
      return {
        message: ++step === 1 ? {
          role: "assistant" as const, content: null,
          tool_calls: [{ id: "save", type: "function" as const, function: {
            name: "write_memory", arguments: JSON.stringify({ file: "PREFERENCES.md", content: "# Preferences\nUse concise bullet points.\n" }),
          } }],
        } : { role: "assistant" as const, content: "Saved" },
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      };
    } },
  });
  const memory = new BotMemory(bot, database);
  expect(await memory.read("PREFERENCES.md")).toContain("concise bullet points");
  await memory.write("KNOWLEDGE.md", "# Knowledge\nVerified report path: reports/latest.md\n");
  const writer = await createBot(LOCAL_USER, { name: "Writer", role: "Author", job: "Write" }, database);
  expect(await new BotMemory(writer, database).read("KNOWLEDGE.md")).toBe("# Knowledge\n");
  for (const identity of [bot, writer]) {
    await runAgent("What do you know?", {
      bot: identity, database, computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER, tools: [readMemory], maxSteps: 1,
      model: { async reply(messages) {
        const prompt = messages[0]!.content!;
        if (identity === bot) {
          expect(prompt).toContain("concise bullet points");
          expect(prompt).toContain("reports/latest.md");
        } else {
          expect(prompt).not.toContain("concise bullet points");
          expect(prompt).not.toContain("reports/latest.md");
        }
        return { message: { role: "assistant" as const, content: "Done" }, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } };
      } },
    });
  }
});

it("gives each bot a stable ID and rejects names that differ only by case", async () => {
  expect(bot.id).toMatch(/^[0-9a-f]{24}$/);
  await expect(createBot(LOCAL_USER, { name: "SCOUT", role: "Other", job: "Other" }, database)).rejects.toThrow("already exists");
  const other = await createBot(LOCAL_USER, { name: "Other", role: "Other", job: "Other" }, database);
  expect(other.id).not.toBe(bot.id);
});

it("loads the latest memory for a scheduled bot run", async () => {
  const job = await createScheduledJob(LOCAL_USER, { name: "Report", task: "Report", bot, runAt: new Date(Date.now() + 60000).toISOString() }, database);
  await new BotMemory(bot, database).write("KNOWLEDGE.md", "# Knowledge\nNew finding after scheduling\n");
  const nextRunAt = new Date(0).toISOString();
  await database.run("UPDATE scheduled_jobs SET next_run_at = ?, data = ? WHERE id = ?", [nextRunAt, JSON.stringify({ ...job, nextRunAt }), job.id]);
  let executed = false;
  await runScheduler(async (saved) => {
    return runAgent(saved.task, {
      bot: saved.bot, database, computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER, tools: [], maxSteps: 1,
      model: { async reply(messages) {
        executed = true;
        expect(messages[0]!.content).toContain("New finding after scheduling");
        return { message: { role: "assistant" as const, content: "Done" }, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } };
      } },
    });
  }, { database, once: true });
  expect(executed).toBe(true);
  expect((await listScheduledJobs(LOCAL_USER, database))[0]).toMatchObject({ status: "completed", runCount: 1 });
});
