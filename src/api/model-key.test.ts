import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { ModelKeyService } from "../model-keys.ts";
import { KEY_CHECKS } from "./model-key.ts";
import { createApiServer } from "./server.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let server: ReturnType<typeof createApiServer>;
let base: string;

beforeEach(async () => {
  database = createSqliteDatabase();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => String(url).startsWith("https://api.openai.com/")
    ? Response.json({ id: "gpt-test" }) : Response.json({ data: { label: "mine", endpoints: [] } }));
  const modelKeys = new ModelKeyService({ database: () => database, env: { PEKKA_PLUGIN_KEY: "cd".repeat(32) }, fetch });
  server = createApiServer({ database, auth: null, modelKeys });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/model-keys`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  database.close();
});

const call = (method: string, path = "", body?: unknown) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

it("saves a key per provider, switches between them and removes one, without ever returning a key", async () => {
  expect(await (await call("GET")).json()).toMatchObject({ available: true, active: null, keys: { openrouter: null, openai: null, anthropic: null } });

  const saved = await call("PUT", "/openai", { model: "gpt-test", apiKey: "sk-private-key-9876" });
  expect(saved.status).toBe(200);
  const text = await saved.text();
  expect(text).not.toContain("private");
  expect(JSON.parse(text)).toMatchObject({ active: "openai", keys: { openai: { model: "gpt-test", hint: "9876" } } });

  await call("PUT", "/openrouter", { model: "vendor/model", apiKey: "sk-or-v1-private-1234" });
  expect(await (await call("PUT", "/active", { provider: "openai" })).json()).toMatchObject({ active: "openai" });
  expect(await (await call("PUT", "/active", { provider: null })).json()).toMatchObject({ active: null });

  expect(await (await call("DELETE", "/openai")).json()).toMatchObject({ keys: { openai: null, openrouter: { hint: "1234" } } });
});

it("answers 400 with the reason when a key can't be saved or used", async () => {
  const missingKey = await call("PUT", "/anthropic", { model: "claude-opus-5-5" });
  expect(missingKey.status).toBe(400);
  expect(await missingKey.json()).toMatchObject({ error: "Enter your Anthropic API key." });
  const unsaved = await call("PUT", "/active", { provider: "anthropic" });
  expect(unsaved.status).toBe(400);
  expect(await unsaved.json()).toMatchObject({ error: "Save your Anthropic key first." });
  expect((await call("PUT", "/gemini", { model: "x", apiKey: "12345678" })).status).toBe(404);
});

it("limits how often a user can have keys checked, so the server can't be used to test stolen keys", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    for (let attempt = 0; attempt < KEY_CHECKS.limit; attempt++) {
      expect((await call("PUT", "/openai", { model: "gpt-test", apiKey: `sk-attempt-${attempt}-0000` })).status).toBe(200);
    }
    const refused = await call("PUT", "/openai", { model: "gpt-test", apiKey: "sk-one-too-many-0000" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: "Too many key checks. Try again in 10 minutes." });
    expect((await call("PUT", "/active", { provider: null })).status).toBe(200);

    vi.setSystemTime(Date.now() + KEY_CHECKS.windowMs);
    expect((await call("PUT", "/openai", { model: "gpt-test", apiKey: "sk-later-key-0000" })).status).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});
