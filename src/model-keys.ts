import { z } from "zod";
import type { Config } from "./config.ts";
import { ensureSchema, getDatabase, type Database } from "./database/database.ts";
import { checkAnthropicKey, createAnthropicModel } from "./model/anthropic.ts";
import { KeyCheckError, type Model } from "./model/model.ts";
import { checkOpenAIKey, createOpenAIModel } from "./model/openai.ts";
import { checkOpenRouterKey, createOpenRouterModel, fetchContextWindow } from "./model/openrouter.ts";
import { seal, unseal } from "./plugins/secrets.ts";

// Bring your own key: a user can save an API key for each of OpenRouter, OpenAI
// and Anthropic, and pick one for their runs. Every model call made for them then
// uses it, including scheduled jobs, delegations and greetings. With none picked,
// runs use the server's OpenRouter key, and with neither there's nothing to run them with.

export const PROVIDERS = ["openrouter", "openai", "anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];
const NAMES: Record<Provider, string> = { openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic" };

export class ModelKeyError extends Error {}

/** Why a run can't start when neither the user nor the server has a model key. */
export const NO_MODEL_KEY = "Pekka has no model to run this with yet. Add your OpenRouter, OpenAI or Anthropic key in Settings, or set OPENROUTER_API_KEY on the server.";

export const ModelKeyInput = z.object({
  model: z.string().trim().regex(/^[\w.:/-]{1,200}$/, "Enter a model ID such as claude-opus-5-5."),
  /** Optional when changing only the model of a key already saved. */
  apiKey: z.string().trim().min(8, "That API key looks too short.").max(500).optional(),
}).strict();
type ModelKeyInput = z.infer<typeof ModelKeyInput>;

/** Which saved key runs use, or null for the server's. */
export const ActiveProviderInput = z.object({ provider: z.enum(PROVIDERS).nullable() }).strict();

interface Row { provider: Provider; model: string; credentials: string; hint: string; context_window: number; active: number; updated_at: string }

/** A user's saved provider and model, with the key unsealed. */
export interface ModelChoice { provider: Provider; model: string; apiKey: string; contextWindow?: number }

type Check = (options: { apiKey: string; model: string; fetch?: typeof fetch }) => Promise<{ contextWindow?: number }>;
const CHECKS: Record<Provider, Check> = { openrouter: checkOpenRouterKey, openai: checkOpenAIKey, anthropic: checkAnthropicKey };

export class ModelKeyService {
  private readonly databaseFor: () => Database;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetcher?: typeof fetch;

  constructor(options: { database?: () => Database; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
    this.databaseFor = options.database ?? getDatabase;
    this.env = options.env ?? process.env;
    this.fetcher = options.fetch;
  }

  private sealingKey(): Buffer {
    const key = this.env.PEKKA_PLUGIN_KEY?.trim();
    if (!key || !/^[a-f\d]{64}$/i.test(key)) throw new ModelKeyError("Saving your own API key needs a 64-character hex PEKKA_PLUGIN_KEY on the server. See .env.example.");
    return Buffer.from(key, "hex");
  }

  /** Binds a sealed key to one user and provider, so a row can't be moved to another account or provider. */
  private label(userId: string, provider: Provider) {
    return `pekka:model-key:v1:${userId}:${provider}`;
  }

  private async database() {
    const database = this.databaseFor();
    await ensureSchema(database);
    return database;
  }

  private async rows(userId: string): Promise<Row[]> {
    return (await this.database()).query<Row & Record<string, unknown>>(
      "SELECT provider, model, credentials, hint, context_window, active, updated_at FROM provider_keys WHERE user_id = ?", [userId]);
  }

  private open(userId: string, row: Row): string {
    try {
      return unseal(this.sealingKey(), this.label(userId, row.provider), row.credentials);
    } catch (error) {
      if (error instanceof ModelKeyError) throw error;
      throw new ModelKeyError(`Your saved ${NAMES[row.provider]} key can't be read on this server. Save it again in Settings.`);
    }
  }

  /** What the Settings page shows: each provider's saved key, and which one runs use. Never includes the keys themselves. */
  async status(userId: string) {
    let available = true;
    try { this.sealingKey(); } catch { available = false; }
    const rows = await this.rows(userId);
    const keys = Object.fromEntries(PROVIDERS.map((provider) => {
      const row = rows.find((candidate) => candidate.provider === provider);
      return [provider, row ? { model: row.model, hint: row.hint, updatedAt: row.updated_at } : null];
    })) as Record<Provider, { model: string; hint: string; updatedAt: string } | null>;
    return { available, active: rows.find((row) => row.active)?.provider ?? null, keys };
  }

  /** Checks the key and model with the provider, saves them, and makes them the ones runs use. */
  async save(userId: string, provider: Provider, input: ModelKeyInput) {
    const sealingKey = this.sealingKey();
    let apiKey = input.apiKey;
    if (!apiKey) {
      const row = (await this.rows(userId)).find((candidate) => candidate.provider === provider);
      if (!row) throw new ModelKeyError(`Enter your ${NAMES[provider]} API key.`);
      apiKey = this.open(userId, row);
    }
    let contextWindow: number | undefined;
    try {
      ({ contextWindow } = await CHECKS[provider]({ apiKey, model: input.model, fetch: this.fetcher }));
    } catch (error) {
      if (error instanceof KeyCheckError) throw new ModelKeyError(error.message);
      throw new ModelKeyError(`Couldn't reach ${NAMES[provider]} to check the key. Try again.`);
    }
    await (await this.database()).run(
      `INSERT INTO provider_keys (user_id, provider, model, credentials, hint, context_window, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, provider) DO UPDATE SET model = excluded.model, credentials = excluded.credentials,
         hint = excluded.hint, context_window = excluded.context_window, updated_at = excluded.updated_at`,
      [userId, provider, input.model, seal(sealingKey, this.label(userId, provider), apiKey), apiKey.slice(-4), contextWindow ?? 0, new Date().toISOString()],
    );
    return this.use(userId, provider);
  }

  /** Switches runs to a saved key, or back to the server's with null. */
  async use(userId: string, provider: Provider | null) {
    if (provider && !(await this.rows(userId)).some((row) => row.provider === provider)) {
      throw new ModelKeyError(`Save your ${NAMES[provider]} key first.`);
    }
    // One statement, so a user never has two active keys.
    await (await this.database()).run("UPDATE provider_keys SET active = (provider = ?) WHERE user_id = ?", [provider ?? "", userId]);
    return this.status(userId);
  }

  /** Deletes a saved key. Runs that used it go back to the server's model. */
  async remove(userId: string, provider: Provider) {
    await (await this.database()).run("DELETE FROM provider_keys WHERE user_id = ? AND provider = ?", [userId, provider]);
    return this.status(userId);
  }

  /** The provider, key and model the user picked for their runs, or undefined when they use the server's. */
  async choice(userId: string): Promise<ModelChoice | undefined> {
    const row = (await this.rows(userId)).find((candidate) => candidate.active);
    if (!row) return undefined;
    return { provider: row.provider, model: row.model, apiKey: this.open(userId, row), contextWindow: row.context_window || undefined };
  }
}

let service: ModelKeyService | undefined;
export function getModelKeys(): ModelKeyService {
  service ??= new ModelKeyService();
  return service;
}

const CREATE: Record<Provider, (options: { apiKey: string; model: string }) => Model> = {
  openrouter: createOpenRouterModel, openai: createOpenAIModel, anthropic: createAnthropicModel,
};

/** The model a user's runs use: their own provider and key when they saved one, otherwise the server's OpenRouter model. */
export async function modelFor(userId: string, config: Config, keys: ModelKeyService = getModelKeys()): Promise<{ model: Model; contextWindow?: number }> {
  const choice = await keys.choice(userId);
  if (!choice) {
    if (!config.openRouterApiKey) throw new ModelKeyError(NO_MODEL_KEY);
    return { model: createOpenRouterModel({ apiKey: config.openRouterApiKey, model: config.model }), contextWindow: config.contextWindow ?? await fetchContextWindow(config.model) };
  }
  const contextWindow = choice.contextWindow ?? (choice.provider === "openrouter" ? await fetchContextWindow(choice.model) : undefined);
  return { model: CREATE[choice.provider]({ apiKey: choice.apiKey, model: choice.model }), contextWindow };
}
