import type { ChatMessage, Model, ModelReply, ToolCall, ToolDefinition } from "./model.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ATTEMPTS = 3;

export class OpenRouterError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`OpenRouter request failed (${status}): ${message}`);
    this.status = status;
  }
}

interface OpenRouterResponse {
  error?: { code: number; message: string };
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number | null } };
  error?: { code?: number; message: string };
}

export function createOpenRouterModel(options: { apiKey: string; model: string }): Model {
  return {
    async reply(messages: ChatMessage[], tools: ToolDefinition[], onDelta?: (text: string) => void): Promise<ModelReply> {
      const response = await postWithRetry(options.apiKey, {
        model: options.model,
        messages,
        tools,
        stream: true,
        usage: { include: true },
      });
      return readStream(response, onDelta);
    },
  };
}

async function postWithRetry(apiKey: string, payload: unknown): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await post(apiKey, payload);
    } catch (error) {
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function post(apiKey: string, payload: unknown): Promise<Response> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Pekka",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as OpenRouterResponse;
    throw new OpenRouterError(body.error?.code ?? response.status, body.error?.message ?? response.statusText);
  }
  if (!response.body) throw new OpenRouterError(502, "response contained no stream");
  return response;
}

async function readStream(response: Response, onDelta?: (text: string) => void): Promise<ModelReply> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, ToolCall>();
  let content = "";
  let usage: StreamChunk["usage"];
  let buffer = "";
  let eventData: string[] = [];
  let done = false;

  function handleEvent(): void {
    if (eventData.length === 0) return;
    const data = eventData.join("\n");
    eventData = [];
    if (data === "[DONE]") {
      done = true;
      return;
    }
    const chunk = JSON.parse(data) as StreamChunk;
    if (chunk.error) throw new OpenRouterError(chunk.error.code ?? 502, chunk.error.message);
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta?.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      for (const part of delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        call.id += part.id ?? "";
        call.function.name += part.function?.name ?? "";
        call.function.arguments += part.function?.arguments ?? "";
        calls.set(part.index, call);
      }
    }
  }

  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") handleEvent();
        else if (line.startsWith("data:")) eventData.push(line.slice(5).trimStart());
      }
    }
    if (!done) throw new OpenRouterError(502, "stream ended before [DONE]");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.some((call) => !call.id || !call.function.name)) {
    throw new OpenRouterError(502, "stream contained an incomplete tool call");
  }
  return {
    message: { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    usage: {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
      costUsd: usage?.cost ?? 0,
    },
  };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof OpenRouterError) return error.status === 429 || error.status >= 500;
  return error instanceof TypeError; // fetch throws TypeError on network failures
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
