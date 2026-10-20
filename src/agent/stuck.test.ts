import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import type { AssistantMessage, ChatMessage, Model } from "../model/model.ts";
import type { Tool } from "../tools/tool.ts";
import { runAgent } from "./loop.ts";
import { REMIND_AFTER, STOP_AFTER, StuckDetector } from "./stuck.ts";

const failed = { output: "Error: connection refused", isError: true };
const ok = { output: "status: running", isError: false };

function repeat(detector: StuckDetector, times: number, result = failed, args = "{}") {
  const checks = [];
  for (let i = 0; i < times; i++) {
    detector.record("fetch_status", args, result);
    checks.push(detector.check());
  }
  return checks;
}

describe("StuckDetector", () => {
  it("reminds once when the same call keeps failing the same way, then stops it", () => {
    const checks = repeat(new StuckDetector(), STOP_AFTER);
    expect(checks.slice(0, REMIND_AFTER - 1)).toEqual(Array(REMIND_AFTER - 1).fill({}));
    expect(checks[REMIND_AFTER - 1]!.reminder).toMatch(/fetch_status with the same arguments 5 times and it failed the same way/);
    expect(checks.slice(REMIND_AFTER, STOP_AFTER - 1)).toEqual(Array(STOP_AFTER - 1 - REMIND_AFTER).fill({}));
    expect(checks.at(-1)).toMatchObject({ tool: "fetch_status", stop: expect.stringContaining("stopped running tools"), fallback: expect.stringContaining("connection refused") });
  });

  it("reminds about a repeated result but never stops a call that succeeds", () => {
    const checks = repeat(new StuckDetector(), 20, ok);
    expect(checks.filter((check) => check.reminder)).toHaveLength(1);
    expect(checks[REMIND_AFTER - 1]!.reminder).toMatch(/got the same result each time.*waiting for something to change/s);
    expect(checks.some((check) => check.stop)).toBe(false);
  });

  it("starts a new streak when the arguments or the result change", () => {
    const detector = new StuckDetector();
    repeat(detector, REMIND_AFTER - 1);
    detector.record("fetch_status", '{"page":2}', failed);
    expect(detector.check()).toEqual({});
    repeat(detector, REMIND_AFTER - 2);
    detector.record("fetch_status", "{}", { output: "Error: timed out", isError: true });
    expect(detector.check()).toEqual({});
    // A fresh streak can be reminded again.
    expect(repeat(detector, REMIND_AFTER).filter((check) => check.reminder)).toHaveLength(1);
  });

  it("doesn't treat a repeated permission refusal as a failure to stop", () => {
    const refused = { output: "Error: Permission denied for send_email. The action was not executed.", isError: true };
    const checks = repeat(new StuckDetector(), STOP_AFTER + 2, refused);
    expect(checks.some((check) => check.stop)).toBe(false);
    expect(checks[REMIND_AFTER - 1]!.reminder).toMatch(/got the same result each time/);
  });
});

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

const call = (id: string, name = "fetch_status", args = {}): AssistantMessage =>
  ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

describe("runAgent stuck detection", () => {
  it("ends a run that keeps making the same failing call, with the model's explanation", async () => {
    let runs = 0;
    const fetchStatus: Tool = { name: "fetch_status", description: "Check the job", permission: { effect: "read" }, input: z.object({}), run: async () => { runs++; throw new Error("connection refused"); } };
    const replies = Array.from({ length: STOP_AFTER + 1 }, (_, index) => call(`call_${index + 1}`));
    replies.push({ role: "assistant", content: "The status service refused every connection.", tool_calls: replies[0]!.tool_calls });
    const { model, seen } = scriptedModel(replies.slice(0, STOP_AFTER).concat(replies.at(-1)!));

    const result = await runAgent("Check the job", { model, computer: new FakeComputer(), userId: LOCAL_USER, database: createSqliteDatabase(), tools: [fetchStatus], maxSteps: 30 });

    expect(result).toMatchObject({ status: "done", answer: "The status service refused every connection.", steps: STOP_AFTER + 1, stoppedRepeating: "fetch_status" });
    // The tool call in the final reply was not run.
    expect(runs).toBe(STOP_AFTER);
    const notes = (messages: ChatMessage[]) => messages.filter((message) => message.role === "user" && message.content?.startsWith("[Pekka: You have called"));
    expect(notes(seen[REMIND_AFTER - 1]!)).toEqual([]);
    expect(notes(seen[REMIND_AFTER]!)).toHaveLength(1);
    expect(seen.at(-1)!.at(-1)!.content).toContain("Reply now without calling any tools");
    expect(notes(result.messages)).toHaveLength(2);
  });

  it("reports what failed when the stopped model gives no explanation", async () => {
    const fetchStatus: Tool = { name: "fetch_status", description: "Check the job", permission: { effect: "read" }, input: z.object({}), run: async () => { throw new Error("connection refused"); } };
    const { model } = scriptedModel(Array.from({ length: STOP_AFTER + 1 }, (_, index) => call(`call_${index + 1}`)));

    const result = await runAgent("Check the job", { model, computer: new FakeComputer(), userId: LOCAL_USER, database: createSqliteDatabase(), tools: [fetchStatus], maxSteps: 30 });

    expect(result.status).toBe("done");
    expect(result.answer).toMatch(/^I stopped because fetch_status kept failing the same way after 8 tries:\n\nError: connection refused/);
  });
});
