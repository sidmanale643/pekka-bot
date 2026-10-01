import { expect, it } from "vitest";
import { createBot } from "./bots.ts";
import { getCharacter, saveCharacter, CharacterSchema } from "./characters.ts";
import { createSqliteDatabase } from "./database/sqlite.ts";
import { FakeComputer } from "./computer/fake-computer.ts";
import { runAgent } from "./agent/loop.ts";
import { LOCAL_USER } from "./database/database.ts";

it("defaults to normal and loads the current persisted character on each run", async () => {
  const database = createSqliteDatabase();
  try {
    const bot = await createBot(LOCAL_USER, { name: "Scout", role: "Researcher", job: "Research" }, database);
    expect(await getCharacter(bot.id, database)).toEqual({ preset: "normal", name: "", description: "" });
    const prompts: string[] = [];
    const run = () => runAgent("Work", { bot, database, computer: new FakeComputer(), userId: LOCAL_USER, tools: [], maxSteps: 1,
      model: { async reply(messages) {
        prompts.push(messages[0]!.content as string);
        return { message: { role: "assistant", content: "Done" }, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } };
      } },
    });
    await run();
    await saveCharacter(bot.id, { preset: "soundwave", description: "" }, database);
    await run();
    await saveCharacter(bot.id, { preset: "jarvis" }, database);
    await run();
    await saveCharacter(bot.id, { preset: "optimus" }, database);
    await run();
    await saveCharacter(bot.id, { preset: "custom", description: "A gentle space explorer" }, database);
    await run();
    await saveCharacter(bot.id, { preset: "custom", name: "Nova", description: "A gentle space explorer" }, database);
    await run();
    await saveCharacter(bot.id, { preset: "normal", description: "" }, database);
    await run();
    expect(prompts[0]).not.toContain("Character profile");
    expect(prompts[1]).toContain("Soundwave-inspired");
    expect(prompts[1]).toContain("tool correctness and honest reporting take priority");
    expect(prompts[2]).toContain("JARVIS-inspired");
    expect(prompts[3]).toContain("Optimus Prime-inspired");
    expect(prompts[4]).toContain("A gentle space explorer");
    expect(prompts[5]).toContain(JSON.stringify("Nova: A gentle space explorer"));
    expect(prompts[6]).not.toContain("Character profile");
    expect(CharacterSchema.safeParse({ preset: "custom", description: " " }).success).toBe(false);
    expect(CharacterSchema.safeParse({ preset: "naruto" }).success).toBe(false);
    expect(CharacterSchema.safeParse({ preset: "custom", name: "x".repeat(101), description: "Calm" }).success).toBe(false);
    // Switching away from custom clears its name and description.
    expect(CharacterSchema.parse({ preset: "soundwave", name: "Nova", description: "Calm" })).toEqual({ preset: "soundwave", name: "", description: "" });
  } finally { database.close(); }
});

it("adds the name column to character tables created before it existed", async () => {
  const database = createSqliteDatabase();
  try {
    await database.run("CREATE TABLE bot_characters (bot_id TEXT PRIMARY KEY, preset TEXT NOT NULL, description TEXT NOT NULL)");
    await database.run("INSERT INTO bot_characters (bot_id, preset, description) VALUES ('old', 'custom', 'A calm explorer')");
    expect(await getCharacter("old", database)).toEqual({ preset: "custom", name: "", description: "A calm explorer" });
    await saveCharacter("old", { preset: "custom", name: "Nova", description: "A calm explorer" }, database);
    expect(await getCharacter("old", database)).toEqual({ preset: "custom", name: "Nova", description: "A calm explorer" });
  } finally { database.close(); }
});
