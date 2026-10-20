import { describe, expect, it } from "vitest";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import type { AssistantMessage, ChatMessage, Model, ToolDefinition } from "../model/model.ts";
import { defaultTools } from "../tools/index.ts";
import { updatePlan } from "../tools/plan.ts";
import { runAgent } from "./loop.ts";
import { RunPlan, type PlanStep } from "./plan.ts";
import { systemPrompt } from "./system-prompt.ts";

function scriptedModel(replies: AssistantMessage[]) {
  const seen: { messages: ChatMessage[]; tools: ToolDefinition[] }[] = [];
  const model: Model = {
    async reply(messages, tools) {
      seen.push({ messages: structuredClone(messages), tools });
      const message = replies.shift();
      if (!message) throw new Error("scripted model ran out of replies");
      return { message, usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.01 } };
    },
  };
  return { model, seen };
}

function calls(...items: { id: string; name: string; args: unknown }[]): AssistantMessage {
  return { role: "assistant", content: null, tool_calls: items.map(({ id, name, args }) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })) };
}

const steps = (...statuses: [PlanStep["status"], PlanStep["status"], PlanStep["status"]]) =>
  ["Read the notes", "Write the report", "Check it"].map((step, index) => ({ step, status: statuses[index]! }));

describe("run plan", () => {
  it("shows the model its current plan before each reply without keeping copies in the history", async () => {
    const computer = new FakeComputer();
    const { model, seen } = scriptedModel([
      calls({ id: "call_1", name: "update_plan", args: { steps: steps("in_progress", "pending", "pending") } }, { id: "call_2", name: "read_file", args: { path: "notes.txt" } }),
      calls({ id: "call_3", name: "update_plan", args: { steps: steps("completed", "in_progress", "pending") } }, { id: "call_4", name: "write_file", args: { path: "report.md", content: "# Report" } }),
      { role: "assistant", content: "Wrote report.md" },
    ]);

    const result = await runAgent("Write a report from my notes", { model, computer, approveAction: async () => true, userId: LOCAL_USER, database: createSqliteDatabase(), tools: defaultTools, maxSteps: 10 });

    expect(result).toMatchObject({ status: "done", answer: "Wrote report.md", steps: 3 });
    expect(seen[0]!.messages[0]!.content).toContain("# Planning");
    expect(seen[0]!.tools.map((tool) => tool.function.name)).toContain("update_plan");
    // No plan yet, so the first prompt ends with the request.
    expect(seen[0]!.messages.at(-1)!.content).toMatch(/^Write a report from my notes/);
    expect(seen[1]!.messages.at(-1)).toEqual({ role: "user", content: "[Pekka: Your current plan. Update it with update_plan as you work: keep one step in progress, and mark a step done as soon as it is finished.]\n1. in progress: Read the notes\n2. to do: Write the report\n3. to do: Check it" });
    expect(seen[2]!.messages.at(-1)!.content).toContain("1. done: Read the notes\n2. in progress: Write the report");
    // Only the latest plan is ever shown, and none is saved in the run's messages.
    expect(seen[2]!.messages.filter((message) => message.content?.startsWith("[Pekka: Your current plan"))).toHaveLength(1);
    expect(result.messages.some((message) => message.content?.startsWith("[Pekka: Your current plan"))).toBe(false);
    expect(result.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_3")!.content).toBe("Plan saved: 1 of 3 steps done. In progress: Write the report.");
  });

  it("rejects a plan with more than one step in progress", async () => {
    const plan = new RunPlan();
    const context = { computer: new FakeComputer(), userId: LOCAL_USER, plan };
    await expect(updatePlan.run({ steps: steps("in_progress", "in_progress", "pending") }, context)).rejects.toThrow("at most one step in_progress");
    expect(plan.steps).toEqual([]);
    expect(await updatePlan.run({ steps: steps("completed", "completed", "completed") }, context)).toBe("Plan saved: 3 of 3 steps done.");
    await expect(updatePlan.run({ steps: steps("pending", "pending", "pending") }, { computer: new FakeComputer(), userId: LOCAL_USER })).rejects.toThrow("not available");
  });

  it("explains planning only when the run has the tool", () => {
    expect(systemPrompt(undefined, 10, { tools: new Set(["update_plan"]) })).toContain("# Planning");
    expect(systemPrompt(undefined, 10, { tools: new Set(["run_command"]) })).not.toContain("# Planning");
  });
});
