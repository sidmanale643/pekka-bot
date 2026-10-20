import { z } from "zod";
import { PlanStepSchema } from "../agent/plan.ts";
import { defineTool } from "./tool.ts";

export const updatePlan = defineTool({
  name: "update_plan",
  // It only changes this run's own notes.
  permission: { effect: "read" },
  description: "Keep a plan for this task: its steps and where each stands. Send the whole list every time; it replaces the previous one. Keep exactly one step in_progress while you work, mark each step completed as soon as it is finished, and add steps as you discover them. Pekka shows you the current plan before every reply. It lasts for this run only.",
  input: z.object({
    steps: z.array(PlanStepSchema).min(1).max(30).describe("Every step in order, including finished ones."),
  }).strict().refine(({ steps }) => steps.filter((step) => step.status === "in_progress").length <= 1, "Keep at most one step in_progress."),
  async run({ steps }, { plan }) {
    if (!plan) throw new Error("Planning is not available in this run.");
    plan.set(steps);
    const done = steps.filter((step) => step.status === "completed").length;
    const current = steps.find((step) => step.status === "in_progress");
    return `Plan saved: ${done} of ${steps.length} steps done.${current ? ` In progress: ${current.step}.` : ""}`;
  },
});
