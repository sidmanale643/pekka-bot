import { z } from "zod";
import { ApiKeyPlugin, ApiKeyPluginError, type ApiKeyPluginOptions } from "../plugins/api-key.ts";
import type { BrowserCredentials } from "./session.ts";

// A user's Cloudflare Browser Run key, saved in Settings. With one saved, every bot gets a browser.
// Browser Run's API needs the account ID as well as a token, so both are sealed together as
// ACCOUNT_ID:TOKEN, in the same encrypted store as plugin keys.

const API = "https://api.cloudflare.com/client/v4/accounts";

export const BrowserKeyInput = z.object({
  accountId: z.string().trim().regex(/^[a-f\d]{32}$/i, "Enter your 32-character Cloudflare account ID."),
  token: z.string().trim().min(20, "That API token looks too short.").max(900),
}).strict();

export function parseBrowserKey(saved: string): BrowserCredentials {
  const match = /^([a-f\d]{32}):(\S{20,})$/i.exec(saved.trim());
  if (!match) throw new ApiKeyPluginError("Enter your 32-character Cloudflare account ID and an API token with Browser Rendering Edit permission.");
  return { accountId: match[1]!.toLowerCase(), token: match[2]! };
}

type Options = Pick<ApiKeyPluginOptions, "database" | "env" | "fetch">;

export class BrowserKeys {
  private readonly store: ApiKeyPlugin;

  constructor(options: Options = {}) {
    const request = options.fetch ?? fetch;
    this.store = new ApiKeyPlugin({
      id: "browser", name: "Cloudflare Browser Run", baseUrl: API, ...options,
      /** Listing the account's live sessions is free and needs the same permission as starting one. */
      async check(_request, saved) {
        const { accountId, token } = parseBrowserKey(saved);
        let response: Response;
        try {
          response = await request(`${API}/${accountId}/browser-run/devtools/session`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
        } catch { throw new ApiKeyPluginError("Could not reach Cloudflare. Try again."); }
        if (response.status === 401 || response.status === 403) throw new ApiKeyPluginError("Cloudflare rejected the token for this account. Check the account ID, and that the token has Account > Browser Rendering > Edit permission.");
        if (!response.ok) throw new ApiKeyPluginError(`Cloudflare Browser Run returned HTTP ${response.status}. Check the account ID and try again.`);
        return accountId;
      },
    });
  }

  /** What Settings shows: whether the server can store a key, and the account of the saved one. Never the token. */
  async status(userId: string) {
    const { configured, connected, enabled, workspaceName } = await this.store.status(userId);
    const saved = connected && enabled;
    return { available: configured, saved, accountId: saved ? workspaceName : "" };
  }

  /** Checks the account ID and token with Cloudflare, then saves them. */
  async save(userId: string, { accountId, token }: z.infer<typeof BrowserKeyInput>): Promise<void> {
    await this.store.connect(userId, `${accountId}:${token}`);
  }

  /** Forgets the saved key, which turns bots' browsers off. The token stays valid at Cloudflare until deleted there. */
  async remove(userId: string): Promise<void> { await this.store.disconnect(userId); }

  async has(userId: string): Promise<boolean> {
    return (await this.status(userId)).saved;
  }

  async credentials(userId: string): Promise<BrowserCredentials> {
    if (!await this.has(userId)) throw new ApiKeyPluginError("Add your Cloudflare account ID and Browser Run token in Settings to give bots a browser.");
    return parseBrowserKey(await this.store.key(userId));
  }
}

let defaultKeys: BrowserKeys | undefined;
export function getBrowserKeys(): BrowserKeys { return defaultKeys ??= new BrowserKeys(); }
