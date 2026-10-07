import { KeyCheckError, type ChatMessage, type Model, type ModelReply, type ToolCall, type ToolDefinition } from "./model.ts";
import { tracedModel } from "./traced.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODELS_URL = "https://openrouter.ai/api/v1/models";
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRY_DELAY_MS = 60_000;

export class OpenRouterError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, retryAfterMs?: number, provider = "OpenRouter") {
    super(`${provider} request failed (${status}): ${message}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
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

/** An OpenAI-compatible chat completions endpoint: OpenRouter, or OpenAI itself. */
export interface ChatEndpoint {
  provider: string;
  url: string;
  headers?: Record<string, string>;
  /** Asks the endpoint to end the stream with token usage. The two providers spell it differently. */
  usage: Record<string, unknown>;
}

const OPENROUTER: ChatEndpoint = { provider: "OpenRouter", url: OPENROUTER_URL, headers: { "X-Title": "Pekka" }, usage: { usage: { include: true } } };

export function createOpenRouterModel(options: { apiKey: string; model: string; requestTimeoutMs?: number }): Model {
  return createChatCompletionsModel(OPENROUTER, options);
}

export function createChatCompletionsModel(endpoint: ChatEndpoint, options: { apiKey: string; model: string; requestTimeoutMs?: number }): Model {
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("requestTimeoutMs must be a positive integer");
  const model: Model = {
    async reply(messages: ChatMessage[], tools: ToolDefinition[], onDelta?: (text: string) => void, signal?: AbortSignal): Promise<ModelReply> {
      const payload = {
        model: options.model,
        // Other providers' raw content is only for them.
        messages: messages.map(({ ...message }) => { if (message.role === "assistant") delete message.raw; return message; }),
        // Some providers reject an empty tool list.
        ...(tools.length ? { tools } : {}),
        stream: true,
        ...endpoint.usage,
      };
      for (let attempt = 1; ; attempt++) {
        let receivedOutput = false;
        try {
          signal?.throwIfAborted();
          const timeout = AbortSignal.timeout(timeoutMs);
          const response = await post(endpoint, options.apiKey, payload, signal ? AbortSignal.any([signal, timeout]) : timeout);
          return await readStream(endpoint.provider, response, onDelta, () => { receivedOutput = true; });
        } catch (error) {
          if (signal?.aborted || receivedOutput || !isRetryable(error) || attempt >= MAX_ATTEMPTS) throw error;
          const retryAfterMs = error instanceof OpenRouterError ? error.retryAfterMs : undefined;
          // A long provider cooldown should be surfaced rather than retried early.
          if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_DELAY_MS) throw error;
          const backoffMs = 1000 * 2 ** (attempt - 1);
          await sleep(Math.max(retryAfterMs ?? 0, backoffMs * (0.5 + Math.random() * 0.5)), signal);
        }
      }
    },
  };
  return tracedModel(endpoint.provider, options.model, model);
}

const contextWindows = new Map<string, number>();

/**
 * The model's context window in tokens: the largest among its providers, since
 * OpenRouter only routes a prompt to one that fits it. Undefined when OpenRouter
 * doesn't list one, as for routers like openrouter/auto.
 */
export async function fetchContextWindow(model: string, fetcher: typeof fetch = fetch): Promise<number | undefined> {
  const known = contextWindows.get(model);
  if (known) return known;
  try {
    const response = await fetcher(`${MODELS_URL}/${model}/endpoints`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const window = largestWindow(await response.json());
    if (window === 0) return undefined;
    contextWindows.set(model, window);
    return window;
  } catch {
    // Lookup failures aren't cached, so the next run tries again.
    return undefined;
  }
}

function largestWindow(body: unknown): number {
  const endpoints = (body as { data?: { endpoints?: { context_length?: number | null }[] } }).data?.endpoints ?? [];
  return Math.max(0, ...endpoints.map((endpoint) => endpoint.context_length ?? 0));
}

/** Checks that an OpenRouter key works and the model exists, and returns the model's context window. */
export async function checkOpenRouterKey({ apiKey, model, fetch: fetcher = fetch }: { apiKey: string; model: string; fetch?: typeof fetch }): Promise<{ contextWindow?: number }> {
  const key = await fetcher("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (key.status === 401 || key.status === 403) throw new KeyCheckError("OpenRouter rejected this API key.");
  if (!key.ok) throw new KeyCheckError(`OpenRouter couldn't check the key (HTTP ${key.status}). Try again.`);
  const endpoints = await fetcher(`${MODELS_URL}/${model}/endpoints`, { signal: AbortSignal.timeout(10_000) });
  if (endpoints.status === 404) throw new KeyCheckError(`OpenRouter has no model called "${model}".`);
  if (!endpoints.ok) throw new KeyCheckError(`OpenRouter couldn't look up the model (HTTP ${endpoints.status}). Try again.`);
  return { contextWindow: largestWindow(await endpoints.json()) || undefined };
}

async function post(endpoint: ChatEndpoint, apiKey: string, payload: unknown, signal: AbortSignal): Promise<Response> {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...endpoint.headers,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as OpenRouterResponse;
    throw new OpenRouterError(response.status, body.error?.message ?? response.statusText, parseRetryAfter(response.headers.get("Retry-After")), endpoint.provider);
  }
  if (!response.body) throw new OpenRouterError(502, "response contained no stream", undefined, endpoint.provider);
  return response;
}

async function readStream(provider: string, response: Response, onDelta: ((text: string) => void) | undefined, onOutput: () => void): Promise<ModelReply> {
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
    if (chunk.error) throw new OpenRouterError(chunk.error.code ?? 502, chunk.error.message, undefined, provider);
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta?.content) {
        onOutput();
        content += delta.content;
        onDelta?.(delta.content);
      }
      for (const part of delta?.tool_calls ?? []) {
        onOutput();
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
    if (!done) throw new OpenRouterError(502, "stream ended before [DONE]", undefined, provider);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.some((call) => !call.id || !call.function.name)) {
    throw new OpenRouterError(502, "stream contained an incomplete tool call", undefined, provider);
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
  if (error instanceof OpenRouterError) return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600);
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
