import { afterEach, expect, it, vi } from "vitest";
import { createOpenAIModel } from "./openai.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("asks OpenAI for usage its own way and leaves other providers' raw content out", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("")));
  vi.stubGlobal("fetch", fetch);
  const reply = await createOpenAIModel({ apiKey: "sk-test", model: "gpt-test" }).reply([
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Earlier", raw: { provider: "anthropic", content: [{ type: "thinking" }] } },
    { role: "user", content: "Again" },
  ], []);

  expect(reply.message.content).toBe("Hi");
  expect(reply.usage).toMatchObject({ promptTokens: 7, completionTokens: 1, cachedTokens: 3, costUsd: 0 });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/chat/completions");
  expect(init.headers.Authorization).toBe("Bearer sk-test");
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ model: "gpt-test", stream: true, stream_options: { include_usage: true } });
  expect(body.usage).toBeUndefined();
  expect(body.messages[1]).toEqual({ role: "assistant", content: "Earlier" });
});
