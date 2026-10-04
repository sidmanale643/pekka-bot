import { afterEach, expect, it, vi } from "vitest";
import { createOpenRouterModel, fetchContextWindow, OpenRouterError } from "./openrouter.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const reply = (onDelta?: (text: string) => void) => createOpenRouterModel({ apiKey: "test", model: "test" }).reply([], [], onDelta);
const stream = (...chunks: unknown[]) => new Response(chunks.map((chunk) =>
  `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""));
const success = () => stream({ choices: [{ delta: { content: "Hello" } }] }, "[DONE]");

it.each([408, 429, 500, 502, 503, 504])("retries HTTP %s and returns the successful reply once", async (status) => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: 400, message: "temporary" } }, { status }))
    .mockResolvedValueOnce(success());
  vi.stubGlobal("fetch", fetch);
  const onDelta = vi.fn();
  const result = reply(onDelta);
  await vi.runAllTimersAsync();
  expect((await result).message.content).toBe("Hello");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[1].body).toBe(fetch.mock.calls[1]?.[1].body);
  expect(onDelta).toHaveBeenCalledExactlyOnceWith("Hello");
});

it.each([400, 401, 402, 403, 404, 422])("fails immediately on HTTP %s", async (status) => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ error: { code: 503, message: "invalid request" } }, { status }));
  vi.stubGlobal("fetch", fetch);
  await expect(reply()).rejects.toMatchObject({ status });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("stops after three network failures with exponential jitter", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  vi.stubGlobal("fetch", fetch);
  const result = expect(reply()).rejects.toThrow("fetch failed");
  await vi.advanceTimersByTimeAsync(749);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1499);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(["5", "Thu, 01 Jan 2026 00:00:05 GMT"])("honors Retry-After %s", async (retryAfter) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const fetch = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "Retry-After": retryAfter } }))
    .mockResolvedValueOnce(success());
  vi.stubGlobal("fetch", fetch);
  const result = reply();
  await vi.advanceTimersByTimeAsync(4999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("surfaces cooldowns over a minute without retrying early", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("busy", { status: 503, headers: { "Retry-After": "120" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(reply()).rejects.toMatchObject({ status: 503, retryAfterMs: 120_000 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  () => stream({ error: { code: 503, message: "unavailable" } }),
  () => stream({ choices: [{ delta: { role: "assistant" } }] }),
  () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("connection reset")); } })),
])("retries a stream failure before output and cleans up the failed stream", async (failedStream) => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementationOnce(failedStream).mockResolvedValueOnce(success());
  vi.stubGlobal("fetch", fetch);
  const result = reply();
  await vi.runAllTimersAsync();
  expect((await result).message.content).toBe("Hello");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  { content: "partial" },
  { tool_calls: [{ index: 0, id: "call", function: { name: "write", arguments: "{" } }] },
])("does not replay a failed stream after output: %j", async (delta) => {
  const fetch = vi.fn().mockImplementation(() => stream({ choices: [{ delta }] }, { error: { code: 503, message: "unavailable" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(reply()).rejects.toBeInstanceOf(OpenRouterError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not retry malformed stream data or consumer errors", async () => {
  const fetch = vi.fn().mockImplementationOnce(() => stream("invalid JSON")).mockImplementationOnce(success);
  vi.stubGlobal("fetch", fetch);
  await expect(reply()).rejects.toBeInstanceOf(SyntaxError);
  await expect(reply(() => { throw new TypeError("consumer failed"); })).rejects.toThrow("consumer failed");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("passes a timeout signal and retries timeout failures", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const fetch = vi.fn().mockRejectedValueOnce(new DOMException("request timed out", "TimeoutError")).mockResolvedValueOnce(success());
  vi.stubGlobal("fetch", fetch);
  const result = createOpenRouterModel({ apiKey: "test", model: "test", requestTimeoutMs: 10_000 }).reply([], []);
  await vi.runAllTimersAsync();
  await result;
  expect(timeout).toHaveBeenNthCalledWith(1, 10_000);
  expect(timeout).toHaveBeenNthCalledWith(2, 10_000);
  expect(fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
});

it("uses the largest context window among the model's providers and remembers it", async () => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url);
    return Response.json({ data: { endpoints: [{ context_length: 131_072 }, { context_length: 1_000_000 }, { context_length: null }] } });
  });

  expect(await fetchContextWindow("acme/large")).toBe(1_000_000);
  expect(await fetchContextWindow("acme/large")).toBe(1_000_000);
  expect(requested).toEqual(["https://openrouter.ai/api/v1/models/acme/large/endpoints"]);
});

it("returns nothing when OpenRouter lists no window, and asks again next time", async () => {
  const responses = [
    new Response("{}", { status: 404 }),
    Response.json({ data: { endpoints: [] } }),
    Response.json({ data: { endpoints: [{ context_length: 64_000 }] } }),
  ];
  vi.stubGlobal("fetch", async () => responses.shift());

  expect(await fetchContextWindow("acme/router")).toBeUndefined();
  expect(await fetchContextWindow("acme/router")).toBeUndefined();
  expect(await fetchContextWindow("acme/router")).toBe(64_000);
});

it("returns nothing when the lookup fails", async () => {
  vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });

  expect(await fetchContextWindow("acme/offline")).toBeUndefined();
});
