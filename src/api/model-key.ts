import { ActiveProviderInput, ModelKeyError, ModelKeyInput, PROVIDERS, type ModelKeyService, type Provider } from "../model-keys.ts";
import type { Route } from "./auth.ts";
import { body, HttpError, json } from "./http.ts";

const PROVIDER_PATH = new RegExp(`^/api/model-keys/(${PROVIDERS.join("|")})$`);

/** Each save asks the provider whether the key works, so cap them per user to stop the server being used to test stolen keys. */
export const KEY_CHECKS = { limit: 10, windowMs: 10 * 60_000 };

/** Counts a user's key checks over a sliding window, and refuses once they reach the limit. */
function keyCheckLimiter(now: () => number) {
  const recent = new Map<string, number[]>();
  return (userId: string) => {
    const since = now() - KEY_CHECKS.windowMs;
    const checks = (recent.get(userId) ?? []).filter((time) => time > since);
    if (checks.length >= KEY_CHECKS.limit) {
      const minutes = Math.ceil((checks[0]! - since) / 60_000);
      throw new HttpError(429, `Too many key checks. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }
    checks.push(now());
    recent.set(userId, checks);
  };
}

/** The Settings page's model providers: a saved key for each, which one runs use, or the server's model. */
export function modelKeyRoutes(keys: ModelKeyService, serverModel: () => string | undefined, now: () => number = () => Date.now()): Route[] {
  const countCheck = keyCheckLimiter(now);
  const status = async (userId: string) => ({ ...await keys.status(userId), serverModel: serverModel() ?? null });
  const fail = (error: unknown): never => {
    if (error instanceof ModelKeyError) throw new HttpError(400, error.message);
    throw error;
  };
  return [
    ["GET", /^\/api\/model-keys$/, async (_request, response, _params, userId) => { json(response, 200, await status(userId)); }],
    ["PUT", /^\/api\/model-keys\/active$/, async (request, response, _params, userId) => {
      const { provider } = await body(request, ActiveProviderInput);
      await keys.use(userId, provider).catch(fail);
      json(response, 200, await status(userId));
    }],
    ["PUT", PROVIDER_PATH, async (request, response, [provider], userId) => {
      const input = await body(request, ModelKeyInput);
      countCheck(userId);
      await keys.save(userId, provider as Provider, input).catch(fail);
      json(response, 200, await status(userId));
    }],
    ["DELETE", PROVIDER_PATH, async (_request, response, [provider], userId) => {
      await keys.remove(userId, provider as Provider);
      json(response, 200, await status(userId));
    }],
  ];
}
