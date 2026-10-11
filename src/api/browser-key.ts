import { BrowserKeyInput, type BrowserKeys } from "../browser/keys.ts";
import type { Route } from "./auth.ts";
import { body, json } from "./http.ts";
import { keyCheckLimiter } from "./model-key.ts";

/** The Settings page's web browser: the user's Cloudflare Browser Run key, which gives every bot a browser while it's saved. */
export function browserKeyRoutes(keys: BrowserKeys, now: () => number = () => Date.now()): Route[] {
  const countCheck = keyCheckLimiter(now);
  return [
    ["GET", /^\/api\/browser-key$/, async (_request, response, _params, userId) => { json(response, 200, await keys.status(userId)); }],
    ["PUT", /^\/api\/browser-key$/, async (request, response, _params, userId) => {
      const input = await body(request, BrowserKeyInput);
      countCheck(userId);
      await keys.save(userId, input);
      json(response, 200, await keys.status(userId));
    }],
    ["DELETE", /^\/api\/browser-key$/, async (_request, response, _params, userId) => {
      await keys.remove(userId);
      json(response, 200, await keys.status(userId));
    }],
  ];
}
