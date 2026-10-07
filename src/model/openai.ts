import { KeyCheckError, type Model } from "./model.ts";
import { createChatCompletionsModel, fetchContextWindow, type ChatEndpoint } from "./openrouter.ts";

// OpenAI speaks the same chat completions format as OpenRouter, so it shares
// that adapter. OpenAI doesn't report cost, so runs on it show $0.

const OPENAI: ChatEndpoint = {
  provider: "OpenAI",
  url: "https://api.openai.com/v1/chat/completions",
  usage: { stream_options: { include_usage: true } },
};

export function createOpenAIModel(options: { apiKey: string; model: string; requestTimeoutMs?: number }): Model {
  return createChatCompletionsModel(OPENAI, options);
}

/** Checks that an OpenAI key can use the model, and returns its context window from OpenRouter's catalog when listed there. */
export async function checkOpenAIKey({ apiKey, model, fetch: fetcher = fetch }: { apiKey: string; model: string; fetch?: typeof fetch }): Promise<{ contextWindow?: number }> {
  const response = await fetcher(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 401 || response.status === 403) throw new KeyCheckError("OpenAI rejected this API key.");
  if (response.status === 404) throw new KeyCheckError(`OpenAI has no model called "${model}" for this key.`);
  if (!response.ok) throw new KeyCheckError(`OpenAI couldn't check the key (HTTP ${response.status}). Try again.`);
  return { contextWindow: await fetchContextWindow(`openai/${model}`, fetcher) };
}
