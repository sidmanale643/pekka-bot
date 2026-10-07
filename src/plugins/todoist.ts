import { z } from "zod";
import { ApiKeyPlugin, ApiKeyPluginError, type ApiKeyPluginOptions } from "./api-key.ts";

export type TodoistService = ApiKeyPlugin;
type Options = Pick<ApiKeyPluginOptions, "database" | "env" | "fetch">;

export function createTodoistService(options: Options = {}): TodoistService {
  return new ApiKeyPlugin({
    id: "todoist", name: "Todoist", baseUrl: "https://api.todoist.com/api/v1", ...options,
    async check(request) {
      const user = z.object({ email: z.string().optional(), full_name: z.string().optional() }).safeParse(await request("/user"));
      if (!user.success) throw new ApiKeyPluginError("Todoist returned an unexpected answer. Check the API token and try again.");
      return user.data.email || user.data.full_name || "your Todoist account";
    },
  });
}

let defaultService: TodoistService | undefined;
export function getTodoistService(): TodoistService { return defaultService ??= createTodoistService(); }
