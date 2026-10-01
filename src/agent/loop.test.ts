import { describe, expect, it } from "vitest";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import type { AssistantMessage, ChatMessage, Model } from "../model/model.ts";
import { defaultTools } from "../tools/index.ts";
import { runAgent } from "./loop.ts";
import { LOCAL_USER } from "../database/database.ts";

/** A model that plays back pre-written replies and records what it was sent. */
function scriptedModel(replies: AssistantMessage[]) {
  const seen: ChatMessage[][] = [];
  const model: Model = {
    async reply(messages) {
      seen.push(structuredClone(messages));
      const message = replies.shift();
      if (!message) throw new Error("scripted model ran out of replies");
      return { message, usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.01 } };
    },
  };
  return { model, seen };
}

function toolCall(id: string, name: string, args: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function answer(text: string): AssistantMessage {
  return { role: "assistant", content: text };
}

describe("runAgent", () => {
  it("runs tools until the model answers without one", async () => {
    const computer = new FakeComputer({ "/usr/bin/ls": { exitCode: 0, output: "notes.txt" } });
    const { model, seen } = scriptedModel([
      toolCall("call_1", "run_command", { command: "ls" }),
      toolCall("call_2", "write_file", { path: "report.md", content: "# Report" }),
      answer("Saved report.md"),
    ]);

    const result = await runAgent("Write a report", { model, computer, approveAction: async () => true, userId: LOCAL_USER, database: createSqliteDatabase(), tools: defaultTools, maxSteps: 10 });

    expect(result).toMatchObject({ status: "done", answer: "Saved report.md", steps: 3 });
    expect(computer.commands).toEqual(["/usr/bin/ls"]);
    expect(computer.files.get("report.md")).toBe("# Report");
    expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 15, cachedTokens: null, cacheHitRate: null, costUsd: 0.03 });

    // The command's output was sent back to the model on the next step.
    expect(seen[1]?.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "exit code: 0\nnotes.txt" });
  });

  it("stops at the step limit", async () => {
    const computer = new FakeComputer({ "true": { exitCode: 0, output: "" } });
    const { model } = scriptedModel([
      toolCall("call_1", "run_command", { command: "true" }),
      toolCall("call_2", "run_command", { command: "true" }),
    ]);

    const result = await runAgent("Loop forever", { model, computer, approveAction: async () => true, userId: LOCAL_USER, database: createSqliteDatabase(), tools: defaultTools, maxSteps: 2 });

    expect(result).toMatchObject({ status: "step_limit", steps: 2 });
  });

  it("reports tool errors back to the model instead of crashing", async () => {
    const computer = new FakeComputer();
    const { model, seen } = scriptedModel([
      toolCall("call_1", "read_file", { path: "missing.txt" }),
      toolCall("call_2", "delete_everything", {}),
      toolCall("call_3", "run_command", { cmd: "ls" }),
      answer("Could not find the file"),
    ]);

    const result = await runAgent("Read a file", { model, computer, approveAction: async () => true, userId: LOCAL_USER, database: createSqliteDatabase(), tools: defaultTools, maxSteps: 10 });

    expect(result.status).toBe("done");
    const toolReplies = seen[3]!.filter((message) => message.role === "tool").map((message) => message.content);
    expect(toolReplies).toEqual([
      "Error: no such file: missing.txt",
      'Error: unknown tool "delete_everything"',
      expect.stringContaining("Error: invalid arguments"),
    ]);
  });
});
