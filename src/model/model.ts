// The shapes the agent loop uses to talk to a language model.
// They follow the OpenAI-compatible chat format that OpenRouter speaks.

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments, exactly as the model wrote them. */
    arguments: string;
  };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

/** A tool as the model sees it: a name, a description and a JSON Schema. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number | null;
  cacheHitRate?: number | null;
  /** Cost in US dollars, when the provider reports it. */
  costUsd: number;
}

export interface ModelReply {
  message: AssistantMessage;
  usage: Usage;
}

export interface Model {
  reply(messages: ChatMessage[], tools: ToolDefinition[], onDelta?: (text: string) => void, signal?: AbortSignal): Promise<ModelReply>;
}
