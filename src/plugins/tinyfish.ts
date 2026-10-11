import { z } from "zod";
import { ApiKeyPlugin, ApiKeyPluginError, type ApiKeyPluginOptions } from "./api-key.ts";

export type TinyFishService = ApiKeyPlugin;
type Options = Pick<ApiKeyPluginOptions, "database" | "env" | "fetch">;

export function createTinyFishService(options: Options = {}): TinyFishService {
  return new ApiKeyPlugin({
    id: "tinyfish", name: "TinyFish", apiKeyHeader: "X-API-Key", timeoutMs: 120_000,
    baseUrl(path) {
      if (path.startsWith("/search?")) return `https://api.search.tinyfish.ai${path.slice(7)}`;
      if (path === "/fetch") return "https://api.fetch.tinyfish.ai";
      if (path.startsWith("/v1/")) return `https://agent.tinyfish.ai${path}`;
      throw new ApiKeyPluginError("Unknown TinyFish endpoint.");
    },
    ...options,
    async check(request) {
      const result = z.object({ results: z.array(z.unknown()) }).safeParse(await request("/search?query=TinyFish"));
      if (!result.success) throw new ApiKeyPluginError("TinyFish returned an unexpected answer. Check the API key and try again.");
      return "your TinyFish account";
    },
  });
}

let defaultService: TinyFishService | undefined;
export function getTinyFishService(): TinyFishService { return defaultService ??= createTinyFishService(); }
