import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { LOCAL_USER } from "../database/database.ts";
import type { AssistantMessage, ChatMessage, Model, ToolDefinition } from "../model/model.ts";
import type { AgentEvent } from "./events.ts";
import { ContextManager } from "./context.ts";
import { runAgent, type AgentOptions } from "./loop.ts";

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

function toolCall(id: string, content: string | null = null): AssistantMessage {
  return { role: "assistant", content, tool_calls: [{ id, type: "function", function: { name: "work", arguments: "{}" } }] };
}

function toolResult(id: string, content = "worked"): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

function answer(text: string): AssistantMessage {
  return { role: "assistant", content: text };
}

const work = { name: "work", description: "Do some work", input: z.object({}), run: async () => "worked" };
const system: ChatMessage = { role: "system", content: "You are a helpful agent." };
const request: ChatMessage = { role: "user", content: "Run work three times" };
const bulkyCall = toolCall("call_1", "Findings ".repeat(2500));

function options(model: Model, overrides: Partial<AgentOptions> = {}): AgentOptions {
  return { model, computer: new FakeComputer(), userId: LOCAL_USER, database: createSqliteDatabase(), tools: [work], maxSteps: 10, ...overrides };
}

function context(messages: ChatMessage[], model: Model, tools: ToolDefinition[] = []) {
  return new ContextManager(messages, { model, tools, contextWindow: 10_000, task: request.content! });
}

function history(): ChatMessage[] {
  return [system, request, bulkyCall, toolResult("call_1"), toolCall("call_2"), toolResult("call_2"), toolCall("call_3"), toolResult("call_3")];
}

describe("context compaction", () => {
  it("summarizes older messages at half the window, retaining the request and two recent tool turns", async () => {
    const { model, seen } = scriptedModel([
      { message: bulkyCall, promptTokens: 1000 },
      { message: toolCall("call_2"), promptTokens: 5000 },
      { message: toolCall("call_3"), promptTokens: 6000 },
      { message: answer("Ran work once; running it twice more."), promptTokens: 6100 },
      { message: answer("Done"), promptTokens: 2000 },
    ]);
    const events: AgentEvent[] = [];

    const result = await runAgent("Run work three times", options(model, { contextWindow: 10_000, onEvent: (event) => events.push(event) }));

    expect(result).toMatchObject({ status: "done", answer: "Done", steps: 4 });
    expect(events.filter((event) => event.type === "step" || event.type === "compaction")).toEqual([
      { type: "step", step: 1 },
      { type: "step", step: 2 },
      { type: "step", step: 3 },
      { type: "compaction", tokens: expect.any(Number), contextWindow: 10_000 },
      { type: "step", step: 4 },
    ]);
    expect(result.usage).toMatchObject({ promptTokens: 20_100, completionTokens: 25, costUsd: 0.05 });

    const summaryRequest = seen[3]!;
    const after = seen[4]!;
    expect(summaryRequest.messages.slice(0, -1)).toEqual(seen[1]!.messages);
    expect(summaryRequest.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Do not call any tools") });
    expect(summaryRequest.tools).toEqual(seen[0]!.tools);
    expect(after.tools).toEqual(seen[0]!.tools);
    expect(after.messages).toEqual([
      seen[0]!.messages[0],
      { role: "user", content: expect.stringContaining("Ran work once; running it twice more.") },
      seen[0]!.messages.at(-1),
      toolCall("call_2"), toolResult("call_2"),
      toolCall("call_3"), toolResult("call_3"),
    ]);
    expect(result.messages).toEqual([...after.messages, answer("Done")]);
  });

  it("compacts earlier conversation before the first reply, keeping recent conversation and the exact request", async () => {
    const { model, seen } = scriptedModel([
      { message: answer("They planned a trip to Lisbon."), promptTokens: 0 },
      { message: answer("Booked."), promptTokens: 0 },
    ]);
    const conversation = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `Trip planning, part ${index}: ${"details ".repeat(500)}`,
    }));

    const result = await runAgent("Book the hotel", options(model, { contextWindow: 10_000, conversation }));

    expect(result).toMatchObject({ status: "done", answer: "Booked.", steps: 1 });
    const originalRequest = seen[0]!.messages.at(-2)!;
    expect(originalRequest.content).toMatch(/^Book the hotel\n\n\[Pekka: sent /);
    expect(seen[1]!.messages).toEqual([
      seen[0]!.messages[0],
      { role: "user", content: expect.stringContaining("They planned a trip to Lisbon.") },
      ...conversation.slice(-2).map((message) => ({ ...message, content: message.content.slice(0, 4000) })),
      originalRequest,
    ]);
  });

  it("elides stale output in the real loop without spending a model call on summarization", async () => {
    const { model, seen } = scriptedModel([
      { message: toolCall("call_1"), promptTokens: 0 },
      { message: toolCall("call_2"), promptTokens: 0 },
      { message: toolCall("call_3"), promptTokens: 0 },
      { message: answer("Done"), promptTokens: 0 },
    ]);
    const outputs = ["old output ".repeat(2400), "second output", "third output"];
    const events: AgentEvent[] = [];
    const result = await runAgent("Run work three times", options(model, {
      contextWindow: 10_000,
      tools: [{ ...work, run: async () => outputs.shift()! }],
      onEvent: (event) => events.push(event),
    }));

    expect(result).toMatchObject({ status: "done", answer: "Done", steps: 4 });
    expect(seen).toHaveLength(4);
    expect(events.filter((event) => event.type === "compaction")).toEqual([]);
    expect(seen[3]!.messages.filter((message) => message.role === "tool")).toEqual([
      { role: "tool", tool_call_id: "call_1", content: expect.stringContaining("Earlier tool output omitted") },
      toolResult("call_2", "second output"), toolResult("call_3", "third output"),
    ]);
    expect(events.find((event) => event.type === "tool_result" && event.id === "call_1")).toMatchObject({ output: "old output ".repeat(2400) });
  });

  it("keeps messages and accounting when the summary is empty or contains a tool call", async () => {
    for (const message of [answer("  "), toolCall("unexpected", "Here is a summary")]) {
      const { model } = scriptedModel([{ message, promptTokens: 6100 }]);
      const original = history();
      const manager = context(original, model);
      const tokens = manager.tokens();
      expect(manager.shouldCompact()).toBe(true);
      const usage = await manager.compact();
      expect(usage).toMatchObject({ promptTokens: 6100, completionTokens: 5 });
      expect(manager.messages).toEqual(original);
      expect(manager.tokens()).toBe(tokens);
    }
  });

  it("keeps the original request and recent tool batches through repeated compactions", async () => {
    const { model, seen } = scriptedModel([
      { message: answer("First summary"), promptTokens: 0 },
      { message: answer("Second summary"), promptTokens: 0 },
    ]);
    const manager = context(history(), model);
    await manager.compact();
    expect(manager.messages).toEqual([
      system, { role: "user", content: expect.stringContaining("First summary") }, request,
      toolCall("call_2"), toolResult("call_2"), toolCall("call_3"), toolResult("call_3"),
    ]);
    manager.add(toolCall("call_4", "More findings ".repeat(2000)), toolResult("call_4"), toolCall("call_5"), toolResult("call_5"));
    expect(manager.shouldCompact()).toBe(true);
    await manager.compact();
    expect(seen[1]!.messages).toContainEqual({ role: "user", content: expect.stringContaining("First summary") });
    expect(manager.messages).toEqual([
      system, { role: "user", content: expect.stringContaining("Second summary") }, request,
      toolCall("call_4", "More findings ".repeat(2000)), toolResult("call_4"), toolCall("call_5"), toolResult("call_5"),
    ]);
  });
});

describe("context elision and token accounting", () => {
  it("elides parallel stale results without changing raw assistant blocks or call/result pairing", () => {
    const { model } = scriptedModel([]);
    const oldCall = toolCall("call_1");
    oldCall.tool_calls!.push({ ...toolCall("call_extra").tool_calls![0]! });
    oldCall.raw = { provider: "anthropic", content: [{ type: "thinking", thinking: "signed reasoning", signature: "signature" }] };
    const recentCall = toolCall("call_2");
    recentCall.raw = { provider: "anthropic", content: [{ type: "text", text: "recent reasoning" }] };
    const old = [oldCall, toolResult("call_1", "x".repeat(16_000)), toolResult("call_extra", "y".repeat(16_000))];
    const recent = [recentCall, toolResult("call_2", "z".repeat(8000)), toolCall("call_3"), toolResult("call_3", "w".repeat(8000))];
    const manager = context([system, request, ...old, ...recent], model);
    const originalTokens = manager.tokens();

    expect(manager.elide()).toBe(2);
    expect(manager.tokens()).toBeLessThan(originalTokens - 7500);
    expect(manager.messages[2]).toBe(oldCall);
    expect(manager.messages.slice(-4)).toEqual(recent);
    expect(manager.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call_1", "call_extra", "call_2", "call_3"]);
    expect(manager.elide()).toBe(0);
  });

  it("retains extra recent turns that fit the recent token budget", () => {
    const { model } = scriptedModel([]);
    const recent = [toolCall("call_2"), toolResult("call_2"), toolCall("call_3"), toolResult("call_3"), toolCall("call_4"), toolResult("call_4")];
    const manager = context([system, request, toolCall("call_1"), toolResult("call_1", "x".repeat(20_000)), ...recent], model);
    expect(manager.elide()).toBe(1);
    expect(manager.messages.slice(-recent.length)).toEqual(recent);
    expect(manager.shouldCompact()).toBe(false);
  });

  it("leaves stale tool output untouched below the soft threshold", () => {
    const { model } = scriptedModel([]);
    const original = [system, request, toolCall("call_1"), toolResult("call_1", "x".repeat(3000)), toolCall("call_2"), toolResult("call_2"), toolCall("call_3"), toolResult("call_3")];
    const manager = context(original, model);
    expect(manager.elide()).toBe(0);
    expect(manager.messages).toEqual(original);
  });

  it("accounts for tool definitions loaded after the provider's last prompt count", () => {
    const { model } = scriptedModel([]);
    const tools: ToolDefinition[] = [{ type: "function", function: { name: "work", description: "Do work", parameters: {} } }];
    const manager = context([system, request], model, tools);
    manager.addReply(toolCall("call_1"), { promptTokens: 3000, completionTokens: 100, costUsd: 0 });
    const before = manager.tokens();
    const loaded = [...tools, { type: "function" as const, function: { name: "plugin", description: "plugin details ".repeat(1000), parameters: {} } }];
    manager.setTools(loaded);
    expect(manager.tokens() - before).toBe(Math.ceil(JSON.stringify(loaded).length / 4) - Math.ceil(JSON.stringify(tools).length / 4));
    manager.addReply(toolCall("call_2"), { promptTokens: 7000, completionTokens: 100, costUsd: 0 });
    expect(manager.tokens()).toBe(7101);
  });

  it("recomputes the prompt estimate after eliding previously counted output", () => {
    const { model } = scriptedModel([]);
    const manager = context([system, request, toolCall("call_1"), toolResult("call_1", "x".repeat(24_000)), toolCall("call_2"), toolResult("call_2")], model);
    manager.addReply(toolCall("call_3"), { promptTokens: 9000, completionTokens: 5, costUsd: 0 });
    manager.add(toolResult("call_3"));
    expect(manager.elide()).toBe(1);
    expect(manager.tokens()).toBe(Math.ceil(JSON.stringify(manager.messages).length / 4) + Math.ceil(JSON.stringify([]).length / 4));
    expect(manager.shouldCompact()).toBe(false);
  });
});
