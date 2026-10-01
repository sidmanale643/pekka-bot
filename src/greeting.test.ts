import { afterEach, describe, expect, it } from "vitest";
import { BotMemory } from "./bot-memory.ts";
import type { Bot } from "./bots.ts";
import { saveCharacter } from "./characters.ts";
import { createSqliteDatabase } from "./database/sqlite.ts";
import { createGreeting, parseGreeting } from "./greeting.ts";
import type { ChatMessage, Model } from "./model/model.ts";

const bot: Bot = { id: "a".repeat(24), name: "Scout", role: "Researcher", job: "Find repos" };
let database: ReturnType<typeof createSqliteDatabase> | undefined;

afterEach(() => database?.close());

describe("parseGreeting", () => {
  it("reads JSON wrapped in other text and keeps three suggestions", () => {
    const text = 'Sure:\n```json\n{"message": " Hello! ", "suggestions": ["A", "", 4, "B", "C", "D"]}\n```';
    expect(parseGreeting(text, bot)).toEqual({ message: "Hello!", suggestions: ["A", "B", "C"] });
  });

  it("falls back when the reply is not usable", () => {
    const fallback = { message: "Hi, I'm Scout. What would you like me to work on?", suggestions: [] };
    expect(parseGreeting("no json here", bot)).toEqual(fallback);
    expect(parseGreeting('{"suggestions": ["Look"]}', bot)).toEqual({ ...fallback, suggestions: ["Look"] });
  });
});

describe("createGreeting", () => {
  it("asks the model without tools, using the bot's profile, memory and character", async () => {
    database = createSqliteDatabase();
    await new BotMemory(bot, database).write("KNOWLEDGE.md", "User follows RAG papers.");
    await saveCharacter(bot.id, { preset: "jarvis" }, database);
    const calls: { messages: ChatMessage[]; tools: unknown[] }[] = [];
    const model: Model = {
      async reply(messages, tools) {
        calls.push({ messages, tools });
        return {
          message: { role: "assistant", content: '{"message": "Welcome back.", "suggestions": ["Summarise new RAG papers"]}' },
          usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
        };
      },
    };
    expect(await createGreeting(bot, model, database)).toEqual({ message: "Welcome back.", suggestions: ["Summarise new RAG papers"] });
    expect(calls[0]!.tools).toEqual([]);
    expect(calls[0]!.messages[0]!.content).toContain("JARVIS");
    expect(calls[0]!.messages[1]!.content).toContain("Role: Researcher");
    expect(calls[0]!.messages[1]!.content).toContain("User follows RAG papers.");
  });
});
