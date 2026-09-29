import type { Computer } from "../computer/computer.ts";
import type { ChatMessage, Model, Usage } from "../model/model.ts";
import { toToolDefinition, type Tool } from "../tools/tool.ts";
import type { EventHandler } from "./events.ts";
import { executeToolCall } from "./execute-tool-call.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import type { Bot } from "../bots.ts";

export interface AgentOptions {
  model: Model;
  computer: Computer;
  tools: Tool[];
  /** Stop after this many model replies, even if the task isn't finished. */
  maxSteps: number;
  bot?: Bot;
  onEvent?: EventHandler;
}

export interface AgentResult {
  /** "done" when the model gave a final answer, "step_limit" when it ran out of steps. */
  status: "done" | "step_limit";
  answer: string;
  steps: number;
  usage: Usage;
  messages: ChatMessage[];
}

/**
 * The agent loop: ask the model what to do, run the tools it asks for,
 * give it the results, and repeat until it answers without calling a tool.
 */
export async function runAgent(task: string, options: AgentOptions): Promise<AgentResult> {
  const { model, computer, tools, maxSteps } = options;
  const emit = options.onEvent ?? (() => {});
  const toolDefinitions = tools.map(toToolDefinition);
  const usage: Usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
  const messages: ChatMessage[] = [
    { role: "system", content: options.bot ? `${SYSTEM_PROMPT}\n\nYour name is ${options.bot.name}.\nYour role is ${options.bot.role}.\nYour job is ${options.bot.job}.` : SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    emit({ type: "step", step });

    const reply = await model.reply(messages, toolDefinitions, (text) => emit({ type: "message_delta", text }));
    addUsage(usage, reply.usage);
    messages.push(reply.message);

    const text = reply.message.content ?? "";
    if (text) emit({ type: "message", text });

    const calls = reply.message.tool_calls ?? [];
    if (calls.length === 0) {
      return { status: "done", answer: text, steps: step, usage, messages };
    }

    for (const call of calls) {
      emit({ type: "tool_call", name: call.function.name, arguments: call.function.arguments });
      const result = await executeToolCall(call, tools, { computer });
      emit({ type: "tool_result", name: call.function.name, ...result });
      messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
    }
  }

  return { status: "step_limit", answer: "", steps: maxSteps, usage, messages };
}

function addUsage(total: Usage, next: Usage): void {
  total.promptTokens += next.promptTokens;
  total.completionTokens += next.completionTokens;
  total.costUsd += next.costUsd;
}
