import { z } from "zod";

export const PlanStepSchema = z.object({
  step: z.string().trim().min(1).max(300).describe("A concrete step, such as \"Read the March invoices\"."),
  status: z.enum(["pending", "in_progress", "completed"]),
}).strict();

export type PlanStep = z.infer<typeof PlanStepSchema>;

const LABELS: Record<PlanStep["status"], string> = { pending: "to do", in_progress: "in progress", completed: "done" };

/**
 * A run's plan, kept by the model through update_plan. It lives outside the
 * conversation: the loop shows the current plan before each reply instead of
 * keeping every version in the history, so it never goes stale or fills the context.
 */
export class RunPlan {
  steps: PlanStep[] = [];

  set(steps: PlanStep[]): void {
    this.steps = steps.map((step) => ({ ...step }));
  }

  /** The note added to the end of the next prompt, or nothing before the model has made a plan. */
  reminder(): string | undefined {
    if (!this.steps.length) return undefined;
    const lines = this.steps.map(({ step, status }, index) => `${index + 1}. ${LABELS[status]}: ${step}`);
    return `[Pekka: Your current plan. Update it with update_plan as you work: keep one step in progress, and mark a step done as soon as it is finished.]\n${lines.join("\n")}`;
  }
}
