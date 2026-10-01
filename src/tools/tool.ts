import { z } from "zod";
import type { Computer } from "../computer/computer.ts";
import type { ToolDefinition } from "../model/model.ts";
import type { Bot } from "../bots.ts";
import type { BotMemory } from "../bot-memory.ts";
import type { SkillStore } from "../skills.ts";

/** Tool output is trimmed to this size so one command can't flood the model's context. */
const MAX_OUTPUT_CHARS = 20_000;

export interface ToolContext {
  computer: Computer;
  userId: string;
  bot?: Bot;
  memory?: BotMemory;
  skills?: SkillStore;
}

/**
 * Every tool has this shape. `input` both validates what the model sent and
 * becomes the JSON Schema the model is shown.
 */
export interface Tool<Input = any> {
  name: string;
  description: string;
  input: z.ZodType<Input>;
  run(input: Input, context: ToolContext): Promise<string>;
}

/** Identity function that lets TypeScript infer `Input` from the schema. */
export function defineTool<Input>(tool: Tool<Input>): Tool<Input> {
  return tool;
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
