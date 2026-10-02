import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { LOCAL_USER } from "../database/database.ts";
import type { AssistantMessage, ChatMessage, Model, ToolDefinition } from "../model/model.ts";
import type { AgentEvent } from "./events.ts";
import { runAgent, type AgentOptions } from "./loop.ts";

/** A model that plays back replies, each reporting the given prompt size, and records what it was sent. */
function scriptedModel(replies: { message: AssistantMessage; promptTokens: number }[]) {
  const seen: { messages: ChatMessage[]; tools: ToolDefinition[] }[] = [];
  const model: Model = {
    async reply(messages, tools) {
      seen.push(structuredClone({ messages, tools }));
      const reply = replies.shift();
      if (!reply) throw new Error("scripted model ran out of replies");
      return { message: reply.message, usage: { promptTokens: reply.promptTokens, completionTokens: 5, costUsd: 0.01 } };
    },
  };
  return { model, seen };
}

function toolCall(id: string): AssistantMessage {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "work", arguments: "{}" } }] };
}

function answer(text: string): AssistantMessage {
  return { role: "assistant", content: text };
}

const work = { name: "work", description: "Do some work", input: z.object({}), run: async () => "worked" };

function options(model: Model, overrides: Partial<AgentOptions> = {}): AgentOptions {
  return { model, computer: new FakeComputer(), userId: LOCAL_USER, database: createSqliteDatabase(), tools: [work], maxSteps: 10, ...overrides };
}

describe("context compaction", () => {
  it("summarizes older messages once the prompt reaches half the context window", async () => {
    const { model, seen } = scriptedModel([
      { message: toolCall("call_1"), promptTokens: 3000 },
      { message: toolCall("call_2"), promptTokens: 6000 },
      { message: answer("Ran work once; running it again."), promptTokens: 6100 },
      { message: answer("Done"), promptTokens: 2000 },
    ]);
    const events: AgentEvent[] = [];

    const result = await runAgent("Run work twice", options(model, { contextWindow: 10_000, onEvent: (event) => events.push(event) }));

    expect(result).toMatchObject({ status: "done", answer: "Done", steps: 3 });
    expect(events.filter((event) => event.type === "step" || event.type === "compaction")).toEqual([
      { type: "step", step: 1 },
      { type: "step", step: 2 },
      { type: "compaction", tokens: expect.any(Number), contextWindow: 10_000 },
      { type: "step", step: 3 },
    ]);
    expect(result.usage).toMatchObject({ promptTokens: 17_100, completionTokens: 20 });

    // The summary request continues the prompt the model last read, with the same tools.
    const [, before, summaryRequest, after] = seen;
    expect(summaryRequest!.messages.slice(0, -1)).toEqual(before!.messages);
    expect(summaryRequest!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Do not call any tools") });
    expect(summaryRequest!.tools).toEqual(before!.tools);

    // Afterwards the model sees the system prompt, the request and summary, and the step it hasn't answered yet.
    expect(after!.messages).toEqual([
      before!.messages[0],
      { role: "user", content: expect.stringMatching(/Run work twice[\s\S]*Ran work once; running it again\./) },
      toolCall("call_2"),
      { role: "tool", tool_call_id: "call_2", content: "worked" },
    ]);
    expect(result.messages).toEqual([...after!.messages, answer("Done")]);
  });

  it("compacts a long earlier conversation before the first reply", async () => {
    const { model, seen } = scriptedModel([
      { message: answer("They planned a trip to Lisbon."), promptTokens: 0 },
      { message: answer("Booked."), promptTokens: 0 },
    ]);
    const conversation = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `Trip planning, part ${index}: ${"details ".repeat(500)}`,
    }));

    const result = await runAgent("Book the hotel", options(model, { contextWindow: 20_000, conversation }));

    expect(result).toMatchObject({ status: "done", answer: "Booked.", steps: 1 });
    expect(seen[0]!.messages).toHaveLength(23);
    expect(seen[1]!.messages).toEqual([
      seen[0]!.messages[0],
      { role: "user", content: expect.stringMatching(/Book the hotel[\s\S]*They planned a trip to Lisbon\./) },
    ]);
  });

  it("keeps the messages when the model writes no summary", async () => {
    const { model, seen } = scriptedModel([
      { message: toolCall("call_1"), promptTokens: 3000 },
      { message: toolCall("call_2"), promptTokens: 6000 },
      { message: toolCall("call_3"), promptTokens: 6100 },
      { message: answer("Done"), promptTokens: 6200 },
    ]);

    const result = await runAgent("Run work twice", options(model, { contextWindow: 10_000, maxSteps: 3 }));

    expect(result).toMatchObject({ status: "done", answer: "Done" });
    expect(seen[3]!.messages).toEqual(seen[2]!.messages.slice(0, -1).concat(toolCall("call_2"), { role: "tool", tool_call_id: "call_2", content: "worked" }));
  });
});
