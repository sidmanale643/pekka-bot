import type { ToolCall } from "../model/model.ts";
import type { Tool, ToolContext } from "../tools/tool.ts";
import { isGatedTool } from "../tools/tool.ts";
import { authorizeAction } from "../permissions/policy.ts";
import { traceOperation } from "../tracing.ts";

export interface ToolCallResult {
  output: string;
  isError: boolean;
}

/**
 * Runs one tool call from the model. Every failure (unknown tool, bad JSON,
 * invalid input, a tool that throws) becomes an error message for the model
 * instead of an exception, so the model can see what went wrong and retry.
 */
export async function executeToolCall(
  call: ToolCall,
  tools: Tool[],
  context: ToolContext,
): Promise<ToolCallResult> {
  return traceOperation(call.function.name, "tool", {
    input: parseJson(call.function.arguments) ?? call.function.arguments,
    metadata: { toolCallId: call.id },
  }, async (update) => {
    const result = await runToolCall(call, tools, context);
    update({ output: result.output, ...(result.isError ? { level: "ERROR", statusMessage: "Tool execution failed; see output." } : {}) });
    return result;
  });
}

async function runToolCall(call: ToolCall, tools: Tool[], context: ToolContext): Promise<ToolCallResult> {
  const tool = tools.find((candidate) => candidate.name === call.function.name);
  if (!tool) return failure(`unknown tool "${call.function.name}"`);

  const args = parseJson(call.function.arguments);
  if (args === undefined) return failure("arguments were not valid JSON");

  const input = tool.input.safeParse(args);
  if (!input.success) return failure(`invalid arguments: ${input.error.message}`);

  try {
    if (!isGatedTool(tool)) await authorizeAction(tool.name, tool.permission, input.data, context.approveAction);
    context.signal?.throwIfAborted();
    return { output: await tool.run(input.data, context), isError: false };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

function parseJson(text: string): unknown {
  try {
    // Some models send an empty string for a tool with no arguments.
    return JSON.parse(text || "{}");
  } catch {
    return undefined;
  }
}

function failure(message: string): ToolCallResult {
  return { output: `Error: ${message}`, isError: true };
}
