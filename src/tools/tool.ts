import { z } from "zod";
import type { Computer } from "../computer/computer.ts";
import type { ToolDefinition } from "../model/model.ts";
import type { Bot } from "../bots.ts";
import type { BotMemory } from "../bot-memory.ts";
import type { SkillStore } from "../skills.ts";
import { authorizeAction, type ApproveAction, type ToolPermission } from "../permissions/policy.ts";

/** Tool output is trimmed to this size so one command can't flood the model's context. */
const MAX_OUTPUT_CHARS = 20_000;

export interface ToolContext {
  computer: Computer;
  userId: string;
  bot?: Bot;
  memory?: BotMemory;
  skills?: SkillStore;
  approveAction?: ApproveAction;
}

/**
 * Every tool has this shape. `input` both validates what the model sent and
 * becomes the JSON Schema the model is shown.
 */
export interface Tool<Input = any> {
  name: string;
  description: string;
  input: z.ZodType<Input>;
  permission?: ToolPermission;
  run(input: Input, context: ToolContext): Promise<string>;
}

const gatedTools = new WeakSet<Tool>();

export function isGatedTool(tool: Tool): boolean { return gatedTools.has(tool); }

export function defineTool<Input>(tool: Tool<Input>): Tool<Input> {
  const guarded: Tool<Input> = { ...tool, async run(input, context) {
    const parsed = tool.input.parse(structuredClone(input));
    await authorizeAction(tool.name, tool.permission, parsed, context.approveAction);
    return tool.run(parsed, context);
  } };
  gatedTools.add(guarded);
  return guarded;
}

export function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.input) as Record<string, unknown>,
    },
  };
}

export function limitOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const omitted = text.length - MAX_OUTPUT_CHARS;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[... ${omitted} more characters omitted]`;
}
