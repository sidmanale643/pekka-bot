import Anthropic from "@anthropic-ai/sdk";
import { KeyCheckError, type ChatMessage, type Model, type ModelReply, type ToolCall, type ToolDefinition } from "./model.ts";
import { tracedModel } from "./traced.ts";

// Claude through Anthropic's Messages API. The agent loop keeps OpenAI-style
// messages, so each request is translated here, and each reply keeps Claude's
// own content blocks so its thinking goes back exactly as it came.

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

const MAX_TOKENS = 64_000;
/** Lets a request drop thinking blocks whose conversation changed, instead of failing. */
const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models from before adaptive thinking (Claude 3, and 4.5 and earlier) run without thinking. */
const NO_ADAPTIVE_THINKING = /^claude-(?:3|haiku-4|(?:opus|sonnet)-4(?:-[0-5])?(?:-\d{8})?$)/;
/** Models whose safety classifiers can decline, which the server can hand to a fallback model. */
const SERVER_FALLBACKS = /^claude-(?:fable-5-1|opus-5|opus-5-5|sonnet-5-5)$/;
/** Blocks from a model that declined mid-reply. They stay out of the history the next model reads. */
const DECLINED_BLOCKS = new Set(["thinking", "redacted_thinking", "tool_use", "server_tool_use"]);

export class AnthropicError extends Error {}

interface Options {
  apiKey: string;
  model: string;
  /** Replaces the network, for tests. */
  fetch?: typeof fetch;
}

const client = ({ apiKey, fetch }: Options) => new Anthropic({ apiKey, ...(fetch ? { fetch } : {}) });

export function createAnthropicModel(options: Options): Model {
  const anthropic = client(options);
  const adaptive = !NO_ADAPTIVE_THINKING.test(options.model);
  const fallbacks = SERVER_FALLBACKS.test(options.model);
  const betas = [...(adaptive ? [BINDING_BETA] : []), ...(fallbacks ? [FALLBACK_BETA] : [])];
  const model: Model = {
    async reply(messages, tools, onDelta, signal): Promise<ModelReply> {
      const { system, params } = toAnthropic(messages);
      const request: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
        model: options.model,
        max_tokens: MAX_TOKENS,
        messages: params,
        stream: true,
        ...(system ? { system } : {}),
        ...(tools.length ? { tools: tools.map(toTool) } : {}),
        cache_control: { type: "ephemeral" },
        // Compaction and newly loaded plugins change the conversation, which would otherwise make earlier thinking fail the check.
        ...(adaptive ? { thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } }, output_config: { effort: "high" } } : {}),
        ...(fallbacks ? { fallbacks: "default" } : {}),
        ...(betas.length ? { betas } : {}),
      };
      // Tool inputs stream as they're written, so one Claude couldn't finish as valid JSON is asked for again.
      for (let attempt = 1; ; attempt++) {
        try {
          const stream = anthropic.beta.messages.stream(request, { signal });
          stream.on("text", (text) => onDelta?.(text));
          return toReply(await stream.finalMessage());
        } catch (error) {
          if (error instanceof Anthropic.APIError) throw describe(error);
          if (signal?.aborted || error instanceof AnthropicError || attempt >= 3) throw error;
        }
      }
    },
  };
  return tracedModel("Anthropic", options.model, model);
}

/** Checks that the key works and can use the model, and returns the model's context window. */
export async function checkAnthropicKey(options: Options): Promise<{ contextWindow?: number }> {
  try {
    const info = await client(options).models.retrieve(options.model);
    return { contextWindow: info.max_input_tokens ?? undefined };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new KeyCheckError("Anthropic rejected this API key.");
    if (error instanceof Anthropic.NotFoundError) throw new KeyCheckError(`Anthropic has no model called "${options.model}" for this key.`);
    if (error instanceof Anthropic.APIError) throw new KeyCheckError(`Anthropic couldn't check the key (${describe(error).message}). Try again.`);
    throw error;
  }
}

function describe(error: InstanceType<typeof Anthropic.APIError>): AnthropicError {
  const detail = (error.error as { error?: { message?: string } } | undefined)?.error?.message ?? error.message;
  return new AnthropicError(`Anthropic request failed${error.status ? ` (${error.status})` : ""}: ${detail}`);
}

function toTool({ function: tool }: ToolDefinition): Anthropic.Beta.Messages.BetaTool {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema, eager_input_streaming: true };
}

/** OpenAI-style messages as a system prompt and Claude messages. A run's tool results go back together, in one user turn. */
export function toAnthropic(messages: ChatMessage[]): { system: string; params: MessageParam[] } {
  const system: string[] = [];
  const params: MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") system.push(message.content);
    else if (message.role === "user") params.push({ role: "user", content: message.content || "(empty message)" });
    else if (message.role === "tool") {
      const result: Anthropic.Beta.Messages.BetaToolResultBlockParam = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content || "(no output)" };
      const last = params.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((block) => block.type === "tool_result")) last.content.push(result);
      else params.push({ role: "user", content: [result] });
    } else if (message.raw?.provider === "anthropic") {
      params.push({ role: "assistant", content: message.raw.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
    } else {
      const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseInput(call.function.arguments) });
      if (content.length) params.push({ role: "assistant", content });
    }
  }
  // Claude's conversations open with the user; a chat that starts with the bot's greeting gets a placeholder.
  if (params[0]?.role !== "user") params.unshift({ role: "user", content: "(Earlier conversation follows.)" });
  return { system: system.join("\n\n"), params };
}

function toReply(message: Anthropic.Beta.Messages.BetaMessage): ModelReply {
  const usage = {
    promptTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
    completionTokens: message.usage.output_tokens,
    cachedTokens: message.usage.cache_read_input_tokens ?? 0,
    // Anthropic doesn't report cost in the response.
    costUsd: 0,
  };
  if (message.stop_reason === "refusal") {
    return { message: { role: "assistant", content: "Claude declined to continue with this request." }, usage };
  }
  const content = withoutDeclined(message.content);
  const calls: ToolCall[] = content.flatMap((block) => block.type === "tool_use"
    ? [{ id: block.id, type: "function" as const, function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }]
    : []);
  if (message.stop_reason === "max_tokens" && calls.length) {
    throw new AnthropicError(`Claude's reply reached the ${MAX_TOKENS}-token limit in the middle of a tool call.`);
  }
  const text = content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
  return {
    message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}), raw: { provider: "anthropic", content } },
    usage,
  };
}

/** After a fallback mid-reply, the declined model's thinking and tool calls before the switch are dropped. */
function withoutDeclined(content: ContentBlock[]): ContentBlock[] {
  const boundary = content.findLastIndex((block) => block.type === "fallback");
  return content.filter((block, index) => index > boundary || !DECLINED_BLOCKS.has(block.type));
}

function parseInput(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
