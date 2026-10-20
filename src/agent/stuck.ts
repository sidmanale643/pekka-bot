import type { ToolCallResult } from "./execute-tool-call.ts";

/** Identical calls in a row before the model is reminded, once per streak. */
export const REMIND_AFTER = 5;
/** Identical failing calls in a row after which the run stops calling tools and reports back. */
export const STOP_AFTER = 8;

/** A permission decision is the user's answer, not a failure the model can fix by trying again. */
const PERMISSION = /^Error: Permission (?:required|denied|blocked)\b/;

export interface StuckCheck {
  /** A one-time note telling the model it is repeating itself. */
  reminder?: string;
  /** Tells the model to stop calling tools and answer; the run ends after its reply. */
  stop?: string;
  /** What the run reports if the model doesn't answer after being stopped. */
  fallback?: string;
  tool?: string;
}

/**
 * Notices a run going round in circles: the same tool with byte-identical arguments
 * returning the same result, call after call. Reminds the model once per streak, and
 * ends a streak of identical failures before it uses up the step budget.
 */
export class StuckDetector {
  private key = "";
  private tool = "";
  private output = "";
  private failing = false;
  private repeats = 0;
  private reminded = false;

  /** Records a finished call. Calls from one reply are recorded in the order the model made them. */
  record(name: string, args: string, result: ToolCallResult): void {
    const failing = result.isError && !PERMISSION.test(result.output);
    const key = JSON.stringify([name, args, result.output, failing]);
    if (key === this.key) {
      this.repeats++;
      return;
    }
    Object.assign(this, { key, tool: name, output: result.output, failing, repeats: 1, reminded: false });
  }

  /** What to tell the model after a step, if anything. */
  check(): StuckCheck {
    const { tool, repeats: n } = this;
    if (this.failing && n >= STOP_AFTER) {
      return {
        tool,
        stop: `[Pekka: You have called ${tool} with the same arguments ${n} times and it failed the same way each time, so Pekka has stopped running tools for this task. Reply now without calling any tools: tell the user what you were trying to do, the error you kept getting, and what they could do about it.]`,
        fallback: `I stopped because ${tool} kept failing the same way after ${n} tries:\n\n${this.output.slice(0, 1000)}`,
      };
    }
    if (n < REMIND_AFTER || this.reminded) return {};
    this.reminded = true;
    return {
      tool,
      reminder: this.failing
        ? `[Pekka: You have called ${tool} with the same arguments ${n} times and it failed the same way each time. Repeating it will not work. Read the error, then try a different approach, look at more context, or rethink your plan. Do not make the same call again.]`
        : `[Pekka: You have called ${tool} with the same arguments ${n} times and got the same result each time. You already have that result, so move on to the next step. If you are waiting for something to change, wait longer between checks or tell the user it is still in progress.]`,
    };
  }
}
