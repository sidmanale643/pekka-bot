import { afterEach, expect, it, vi } from "vitest";
import { createOpenRouterModel } from "./openrouter.ts";
import { runAgent } from "../agent/loop.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { LOCAL_USER } from "../database/database.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([
  { cached: [0, 80], total: 80, rate: 0.2 },
  { cached: [0, 0], total: 0, rate: 0 },
  { cached: [undefined, 80], total: null, rate: null },
])("aggregates streamed cache usage $cached by token count", async ({ cached, total, rate }) => {
  let step = 0;
  vi.stubGlobal("fetch", async () => {
    const index = step++;
    const delta = index === 0
      ? { tool_calls: [{ index: 0, id: "call", function: { name: "unknown", arguments: "{}" } }] }
      : { content: "Finished" };
    const usage = { prompt_tokens: index === 0 ? 100 : 300, completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: cached[index] } };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
  });
  const database = createSqliteDatabase();
  try {
    const result = await runAgent("Count usage", {
      model: createOpenRouterModel({ apiKey: "test", model: "test" }),
      computer: new FakeComputer(), userId: LOCAL_USER, database, tools: [], maxSteps: 2,
    });
    expect(result.usage).toEqual({ promptTokens: 400, completionTokens: 20, cachedTokens: total, cacheHitRate: rate, costUsd: 0 });
  } finally {
    database.close();
  }
});
