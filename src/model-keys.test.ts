import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "./database/sqlite.ts";
import { loadConfig } from "./config.ts";
import { ModelKeyError, ModelKeyService, NO_MODEL_KEY, modelFor } from "./model-keys.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
let keys: ModelKeyService;
const env = { PEKKA_PLUGIN_KEY: "ab".repeat(32) };

beforeEach(() => {
  database = createSqliteDatabase();
  upstream = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const target = String(url);
    const auth = new Headers(init?.headers).get("authorization") ?? new Headers(init?.headers).get("x-api-key") ?? "";
    if (auth.includes("bad")) return Response.json({ error: { message: "invalid key" } }, { status: 401 });
    if (target === "https://openrouter.ai/api/v1/key") return Response.json({ data: { label: "mine" } });
    if (target.endsWith("/missing/model/endpoints")) return Response.json({ error: { message: "not found" } }, { status: 404 });
    if (target.includes("openrouter.ai/api/v1/models/")) return Response.json({ data: { endpoints: [{ context_length: 64_000 }, { context_length: 200_000 }] } });
    if (target.startsWith("https://api.openai.com/v1/models/")) return Response.json({ id: "gpt-test", object: "model" });
    throw new Error(`Unexpected request to ${target}`);
  });
  keys = new ModelKeyService({ database: () => database, env, fetch: upstream });
});

afterEach(() => { vi.restoreAllMocks(); database.close(); });

it("checks a key with the provider, then stores it sealed, shows only its last four characters and uses it", async () => {
  const status = await keys.save("alice", "openrouter", { model: "vendor/model", apiKey: "sk-or-v1-secret-1234" });
  expect(status).toMatchObject({ available: true, active: "openrouter", keys: { openrouter: { model: "vendor/model", hint: "1234" }, openai: null, anthropic: null } });
  expect(JSON.stringify(status)).not.toContain("secret");
  const [row] = await database.query<{ credentials: string; context_window: number }>("SELECT credentials, context_window FROM provider_keys WHERE user_id = 'alice'");
  expect(row!.credentials).not.toContain("secret");
  expect(row!.context_window).toBe(200_000);
  await expect(keys.choice("alice")).resolves.toEqual({ provider: "openrouter", model: "vendor/model", apiKey: "sk-or-v1-secret-1234", contextWindow: 200_000 });
  await expect(keys.choice("bob")).resolves.toBeUndefined();
});

it("keeps a key per provider and switches between them", async () => {
  await keys.save("alice", "openrouter", { model: "vendor/model", apiKey: "sk-or-v1-first-1111" });
  const both = await keys.save("alice", "openai", { model: "gpt-test", apiKey: "sk-openai-key-2222" });
  expect(both).toMatchObject({ active: "openai", keys: { openrouter: { hint: "1111" }, openai: { hint: "2222" } } });
  await expect(keys.choice("alice")).resolves.toMatchObject({ provider: "openai", apiKey: "sk-openai-key-2222" });

  expect((await keys.use("alice", "openrouter")).active).toBe("openrouter");
  await expect(keys.choice("alice")).resolves.toMatchObject({ provider: "openrouter", apiKey: "sk-or-v1-first-1111" });
  expect(await database.query("SELECT provider FROM provider_keys WHERE user_id = 'alice' AND active = 1")).toHaveLength(1);

  expect((await keys.use("alice", null)).active).toBeNull();
  await expect(keys.choice("alice")).resolves.toBeUndefined();
  await expect(keys.use("alice", "anthropic")).rejects.toThrow("Save your Anthropic key first.");
});

it("rejects keys and models the provider won't accept, and saves nothing", async () => {
  await expect(keys.save("alice", "openai", { model: "gpt-test", apiKey: "sk-bad-key-0000" })).rejects.toThrow("OpenAI rejected this API key.");
  await expect(keys.save("alice", "openrouter", { model: "missing/model", apiKey: "sk-or-v1-good-0000" })).rejects.toThrow("OpenRouter has no model called \"missing/model\".");
  expect((await keys.status("alice")).keys).toEqual({ openrouter: null, openai: null, anthropic: null });
});

it("explains when the provider can't be reached", async () => {
  upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
  await expect(keys.save("alice", "openai", { model: "gpt-test", apiKey: "sk-good-0000" })).rejects.toThrow("Couldn't reach OpenAI to check the key. Try again.");
});

it("changes a provider's model without retyping its key, but needs a key for a provider not saved yet", async () => {
  await keys.save("alice", "openai", { model: "gpt-test", apiKey: "sk-good-key-5678" });
  await keys.save("alice", "openai", { model: "gpt-other" });
  await expect(keys.choice("alice")).resolves.toMatchObject({ provider: "openai", model: "gpt-other", apiKey: "sk-good-key-5678" });
  await expect(keys.save("alice", "anthropic", { model: "claude-opus-5-5" })).rejects.toThrow("Enter your Anthropic API key.");
});

it("binds a sealed key to its user and provider, so a copied row can't be read", async () => {
  await keys.save("alice", "openai", { model: "gpt-test", apiKey: "sk-good-key-5678" });
  await database.run("INSERT INTO provider_keys (user_id, provider, model, credentials, hint, context_window, active, updated_at) SELECT 'mallory', provider, model, credentials, hint, context_window, active, updated_at FROM provider_keys WHERE user_id = 'alice'");
  await expect(keys.choice("mallory")).rejects.toThrow(ModelKeyError);
  await database.run("UPDATE provider_keys SET provider = 'openrouter' WHERE user_id = 'alice'");
  await expect(keys.choice("alice")).rejects.toThrow(ModelKeyError);
});

it("goes back to the server's model when the key in use is removed, and keeps the others", async () => {
  await keys.save("alice", "openai", { model: "gpt-test", apiKey: "sk-good-key-5678" });
  await keys.save("alice", "openrouter", { model: "vendor/model", apiKey: "sk-or-v1-good-9999" });
  const status = await keys.remove("alice", "openrouter");
  expect(status).toMatchObject({ active: null, keys: { openrouter: null, openai: { hint: "5678" } } });
  await expect(keys.choice("alice")).resolves.toBeUndefined();
});

it("needs PEKKA_PLUGIN_KEY to save a key", async () => {
  const unconfigured = new ModelKeyService({ database: () => database, env: {}, fetch: upstream });
  expect((await unconfigured.status("alice")).available).toBe(false);
  await expect(unconfigured.save("alice", "openai", { model: "gpt-test", apiKey: "sk-good-key-5678" })).rejects.toThrow("PEKKA_PLUGIN_KEY");
  expect(upstream).not.toHaveBeenCalled();
});

it("says how to add a model when neither the user nor the server has a key", async () => {
  const config = loadConfig({});
  await expect(modelFor("alice", config, keys)).rejects.toThrow(new ModelKeyError(NO_MODEL_KEY));
});
