import { expect, it } from "vitest";
import { z } from "zod";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import type { ChatMessage, Model } from "../model/model.ts";
import type { AgentEvent } from "./events.ts";
import { runAgent } from "./loop.ts";
import { LOCAL_USER } from "../database/database.ts";

it("starts all tools before waiting and preserves call order despite errors and out-of-order completion", async () => {
  const gates = Array.from({ length: 3 }, () => {
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  });
  const started: number[] = [];
  const events: AgentEvent[] = [];
  const seen: ChatMessage[][] = [];
  const model: Model = {
    async reply(messages) {
      seen.push(structuredClone(messages));
      return {
        message: seen.length === 1 ? {
          role: "assistant",
          content: null,
          tool_calls: gates.map((_, index) => ({
            id: `call_${index}`,
            type: "function",
            function: { name: "work", arguments: JSON.stringify({ index }) },
          })),
        } : { role: "assistant", content: "Done" },
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      };
    },
  };
  const running = runAgent("Run independent tasks", {
    model,
    computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER,
    database: createSqliteDatabase(),
    maxSteps: 2,
    onEvent: (event) => { events.push(event); },
    tools: [{
      name: "work",
      description: "Do independent work",
      input: z.object({ index: z.number() }),
      async run({ index }: { index: number }) {
        started.push(index);
        return gates[index]!.promise;
      },
    }],
  });

  try {
    await expect.poll(() => started).toEqual([0, 1, 2]);
    gates[2]!.reject(new Error("failed"));
    gates[1]!.resolve("second");
    await expect.poll(() => events.filter((event) => event.type === "tool_result").length).toBe(2);
    // Results arrive in the order they finish, each carrying its own call's ID.
    expect(events.filter((event) => event.type === "tool_result")).toEqual([
      { type: "tool_result", id: "call_2", name: "work", output: "Error: failed", isError: true },
      { type: "tool_result", id: "call_1", name: "work", output: "second", isError: false },
    ]);
    expect(seen).toHaveLength(1);
    gates[0]!.resolve("first");

    expect(await running).toMatchObject({ status: "done", answer: "Done" });
    expect(seen[1]!.filter((message) => message.role === "tool")).toEqual([
      { role: "tool", tool_call_id: "call_0", content: "first" },
      { role: "tool", tool_call_id: "call_1", content: "second" },
      { role: "tool", tool_call_id: "call_2", content: "Error: failed" },
    ]);
  } finally {
    for (const gate of gates) gate.resolve("cleanup");
    await running;
  }
});
