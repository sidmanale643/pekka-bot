// Retell AI is commented out for now. To bring it back, uncomment this file and every line marked "Retell AI".
// import { z } from "zod";
// import { ApiKeyPlugin, ApiKeyPluginError, type ApiKeyPluginOptions } from "./api-key.ts";
//
// export type RetellService = ApiKeyPlugin;
// type Options = Pick<ApiKeyPluginOptions, "database" | "env" | "fetch">;
//
// // Retell has no "who am I" call, so a key is checked by listing the account's
// // phone numbers, and the account is shown by the number calls go out from.
// export function createRetellService(options: Options = {}): RetellService {
//   return new ApiKeyPlugin({
//     id: "retell", name: "Retell AI", baseUrl: "https://api.retellai.com", ...options,
//     async check(request) {
//       const result = z.array(z.object({ phone_number: z.string(), outbound_agents: z.array(z.unknown()).nullish(), outbound_agent_id: z.string().nullish() })).safeParse(await request("/list-phone-numbers"));
//       if (!result.success) throw new ApiKeyPluginError("Retell AI returned an unexpected answer. Check the API key and try again.");
//       const caller = result.data.find((number) => number.outbound_agents?.length || number.outbound_agent_id) ?? result.data[0];
//       return caller ? `Retell AI, calling from ${caller.phone_number}` : "your Retell AI account (no phone number yet)";
//     },
//   });
// }
//
// let defaultService: RetellService | undefined;
// export function getRetellService(): RetellService { return defaultService ??= createRetellService(); }
