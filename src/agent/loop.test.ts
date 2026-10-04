import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import type { AssistantMessage, ChatMessage, Model } from "../model/model.ts";
import { defaultTools, withPlugins } from "../tools/index.ts";
import { runAgent } from "./loop.ts";
import { LOCAL_USER } from "../database/database.ts";
import { saveSkill } from "../skills.ts";

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

afterEach(() => { vi.useRealTimers(); });

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

  it("loads a plugin's tools only when the model asks for them", async () => {
    const shown: string[][] = [];
    const { model, seen } = scriptedModel([
      toolCall("call_1", "gmail_search", { query: "is:unread" }),
      toolCall("call_2", "load_plugin", { plugin: "gmail" }),
      answer("Ready"),
    ]);
    const reply = model.reply;
    model.reply = (messages, tools, ...rest) => { shown.push(tools.map((tool) => tool.function.name)); return reply(messages, tools, ...rest); };

    await runAgent("Check my inbox", { model, computer: new FakeComputer(), userId: LOCAL_USER, database: createSqliteDatabase(), tools: withPlugins(defaultTools, new Set(["gmail", "github"])), maxSteps: 10 });

    // The prompt lists every plugin's tools, but their definitions start unloaded.
    expect(seen[0]?.[0]?.content).toContain("Tools: gmail_search,");
    expect(seen[0]?.[0]?.content).not.toMatch(/notion|telegram|google calendar/i);
    expect(shown[0]).toContain("load_plugin");
    expect(shown[0]).not.toContain("gmail_search");
    expect(seen[1]?.at(-1)?.content).toBe('Error: gmail_search is not loaded. Call load_plugin with plugin "gmail", then call gmail_search again in your next reply.');

    expect(JSON.parse(String(seen[2]?.at(-1)?.content))).toMatchObject({ plugin: "gmail", name: "Gmail", guidance: expect.stringContaining("gmail_send sends as the user") });
    expect(shown[2]).toEqual(expect.arrayContaining(["load_plugin", "gmail_search", "gmail_send"]));
    expect(shown[2]).not.toContain("github_list_issues");
  });

  it("tells the model when the message was sent, without changing the system prompt between runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { model, seen } = scriptedModel([answer("Sunday"), answer("Monday")]);
    const options = { model, computer: new FakeComputer(), userId: LOCAL_USER, database: createSqliteDatabase(), tools: defaultTools, maxSteps: 10 };

    vi.setSystemTime(new Date("2026-10-04T08:12:45Z"));
    await runAgent("What day is it?", options);
    vi.setSystemTime(new Date("2026-10-05T09:30:00Z"));
    await runAgent("And now?", { ...options, conversation: [{ role: "user", content: "What day is it?" }, { role: "assistant", content: "Sunday" }] });

    expect(seen[0]?.at(-1)).toEqual({ role: "user", content: "What day is it?\n\n[Pekka: sent Sunday, 2026-10-04 08:12 UTC. The user's own time zone may differ.]" });
    expect(seen[1]?.at(-1)?.content).toContain("[Pekka: sent Monday, 2026-10-05 09:30 UTC.");
    // Everything before the new message is identical, so it can be served from the provider's cache.
    expect(seen[1]?.[0]).toEqual(seen[0]?.[0]);
    expect(seen[1]?.[1]).toEqual({ role: "user", content: "What day is it?" });
  });

  it("leaves skills out until the user has one", async () => {
    const shown: string[][] = [];
    const { model, seen } = scriptedModel([answer("No skills"), answer("One skill")]);
    const reply = model.reply;
    model.reply = (messages, tools, ...rest) => { shown.push(tools.map((tool) => tool.function.name)); return reply(messages, tools, ...rest); };
    const database = createSqliteDatabase();
    const options = { model, computer: new FakeComputer(), userId: LOCAL_USER, database, tools: defaultTools, maxSteps: 10 };

    await runAgent("Hello", options);
    expect(shown[0]).not.toContain("load_skill");
    expect(shown[0]).not.toContain("list_skills");
    expect(shown[0]).not.toContain("write_skill");
    expect(seen[0]?.[0]?.content).not.toMatch(/# Skills|skill summaries/);

    await saveSkill("research", [{ path: "SKILL.md", content: "---\nname: research\ndescription: How to research a topic.\n---\nSearch first." }], { database });
    await runAgent("Hello", options);
    expect(shown[1]).toEqual(expect.arrayContaining(["load_skill", "list_skills"]));
    expect(seen[1]?.[0]?.content).toContain("# Skills");
    expect(seen[1]?.[0]?.content).toContain('"name":"research"');
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
