import { z } from "zod";
import { ApiKeyPlugin, ApiKeyPluginError, type ApiKeyPluginOptions } from "./api-key.ts";

export type GranolaService = ApiKeyPlugin;
type Options = Pick<ApiKeyPluginOptions, "database" | "env" | "fetch">;

// Granola's public API is read-only and has no "who am I" call, so a key is
// checked by listing one note, and the account is that note's owner if any.
export function createGranolaService(options: Options = {}): GranolaService {
  return new ApiKeyPlugin({
    id: "granola", name: "Granola", baseUrl: "https://public-api.granola.ai", ...options,
    async check(request) {
      const result = z.object({ notes: z.array(z.object({ owner: z.object({ email: z.string().optional(), name: z.string().nullish() }).nullish() })) }).safeParse(await request("/v1/notes?page_size=1"));
      if (!result.success) throw new ApiKeyPluginError("Granola returned an unexpected answer. Check the API key and try again.");
      const owner = result.data.notes[0]?.owner;
      return owner?.email || owner?.name || "your Granola account";
    },
  });
}

let defaultService: GranolaService | undefined;
export function getGranolaService(): GranolaService { return defaultService ??= createGranolaService(); }
