import { afterEach, expect, it, vi } from "vitest";
import { fetchContextWindow } from "./openrouter.ts";

afterEach(() => vi.unstubAllGlobals());

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
