import { z } from "zod";
import { ApiKeyPlugin, ApiKeyPluginError, type ApiKeyPluginOptions } from "./api-key.ts";

export type BlandService = ApiKeyPlugin;
type Options = Pick<ApiKeyPluginOptions, "database" | "env" | "fetch">;

// Bland's account call returns a status and credit balance but no name or
// email, so the account is shown generically. Calls go out from Bland's shared
// pool of numbers unless the user picks one they own.
export function createBlandService(options: Options = {}): BlandService {
  return new ApiKeyPlugin({
    id: "bland", name: "Bland AI", baseUrl: "https://api.bland.ai", ...options,
    async check(request) {
      const result = z.object({ status: z.string() }).safeParse(await request("/v1/me"));
      if (!result.success) throw new ApiKeyPluginError("Bland AI returned an unexpected answer. Check the API key and try again.");
      return "your Bland AI account";
    },
  });
}

let defaultService: BlandService | undefined;
export function getBlandService(): BlandService { return defaultService ??= createBlandService(); }
