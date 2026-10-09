// Retell AI is commented out for now. To bring it back, uncomment this file and every line marked "Retell AI".
import { it } from "vitest";

it.todo("Retell AI tools (commented out for now)");

// import { expect, it } from "vitest";
// import { executeToolCall } from "../agent/execute-tool-call.ts";
// import { FakeComputer } from "../computer/fake-computer.ts";
// import { LOCAL_USER } from "../database/database.ts";
// import { createSqliteDatabase } from "../database/sqlite.ts";
// import { createRetellService } from "../plugins/retell.ts";
// import { defaultTools } from "./index.ts";
// import { createRetellTools } from "./retell.ts";
//
// type Sent = { path: string; init?: { method?: string; body?: unknown } };
// const numbers = [{ phone_number: "+14155550100", nickname: "Spare", outbound_agents: [] }, { phone_number: "+14155550111", nickname: "Main", outbound_agents: [{ agent_id: "agent_abc123", weight: 1 }] }];
//
// function setup(reply: (path: string, count: number) => unknown = (path) => path === "/list-phone-numbers" ? numbers : { call_id: "call_0123456789", call_status: "registered" }) {
//   const sent: Sent[] = [];
//   const service = { async request(_userId: string, path: string, init?: Sent["init"]) { sent.push({ path, ...(init ? { init } : {}) }); return reply(path, sent.length); } };
//   const tools = createRetellTools(service, { pollMs: 1 });
//   const context = { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER };
//   const call = async (name: string, args: unknown) => {
//     const result = await executeToolCall({ id: "1", type: "function", function: { name, arguments: JSON.stringify(args) } }, tools, context);
//     return { ...result, json: () => JSON.parse(result.output) };
//   };
//   return { tools, sent, call };
// }
//
// it("registers the Retell tools under their plugin, with only placing a call as a write", () => {
//   const { tools } = setup();
//   expect(defaultTools.filter((tool) => tool.name.startsWith("retell_")).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
//   expect(tools.every((tool) => tool.permission?.plugin === "retell")).toBe(true);
//   expect(tools.filter((tool) => tool.permission?.effect === "write").map((tool) => tool.name)).toEqual(["retell_call"]);
// });
//
// it("lists numbers with their outbound agents", async () => {
//   const { call } = setup();
//   expect((await call("retell_list_numbers", {})).json()).toEqual([
//     { phone_number: "+14155550100", nickname: "Spare", outbound_agents: [] },
//     { phone_number: "+14155550111", nickname: "Main", outbound_agents: ["agent_abc123"] },
//   ]);
// });
//
// it("calls from the first number with an outbound agent and briefs the agent through dynamic variables", async () => {
//   const { call, sent } = setup();
//   const result = (await call("retell_call", { to_number: "+14155550199", task: "Book a table for four at 7pm Friday.", recipient_name: "Luigi's", variables: { callback: "+14155550123" } })).json();
//   expect(result).toMatchObject({ call_id: "call_0123456789", status: "registered", from_number: "+14155550111" });
//   expect(sent.at(-1)).toEqual({ path: "/v2/create-phone-call", init: { method: "POST", body: {
//     from_number: "+14155550111", to_number: "+14155550199",
//     retell_llm_dynamic_variables: { callback: "+14155550123", task: "Book a table for four at 7pm Friday.", recipient_name: "Luigi's" },
//     metadata: { source: "pekka" },
//   } } });
// });
//
// it("uses a chosen number and agent without listing numbers, and keeps task from being overridden", async () => {
//   const { call, sent } = setup();
//   await call("retell_call", { to_number: "+442071234567", from_number: "+14155550100", agent_id: "agent_xyz9", task: "Confirm the delivery.", variables: { task: "something else" } });
//   expect(sent).toHaveLength(1);
//   expect(sent[0]!.init!.body).toMatchObject({ from_number: "+14155550100", override_agent_id: "agent_xyz9", retell_llm_dynamic_variables: { task: "Confirm the delivery.", recipient_name: "" } });
// });
//
// it("refuses badly formed numbers and explains when no number can call out", async () => {
//   expect((await setup().call("retell_call", { to_number: "415-555-0199", task: "Hi" })).output).toMatch(/E\.164/);
//   const { call, sent } = setup(() => [numbers[0]]);
//   expect((await call("retell_call", { to_number: "+14155550199", task: "Hi" })).output).toMatch(/outbound agent/);
//   expect(sent.map(({ path }) => path)).toEqual(["/list-phone-numbers"]);
// });
//
// it("waits for a call to end and returns Retell's summary and transcript", async () => {
//   const { call, sent } = setup((_path, count) => count < 3
//     ? { call_id: "call_0123456789", call_status: "ongoing" }
//     : { call_id: "call_0123456789", call_status: "ended", to_number: "+14155550199", duration_ms: 83_400, disconnection_reason: "agent_hangup", transcript: "Agent: Hi\nUser: Hello", call_analysis: { call_summary: "Table booked for 7pm.", call_successful: true, in_voicemail: false } });
//   const result = (await call("retell_get_call", { call_id: "call_0123456789", wait_seconds: 5 })).json();
//   expect(sent.map(({ path }) => path)).toEqual(Array(3).fill("/v2/get-call/call_0123456789"));
//   expect(result).toMatchObject({ status: "ended", duration_seconds: 83, ended_because: "agent_hangup", summary: "Table booked for 7pm.", goal_met: true, voicemail: false, transcript: "Agent: Hi\nUser: Hello", next_offset: null });
//   expect(result.note).toBeUndefined();
// });
//
// it("says when a call is still going instead of waiting by default", async () => {
//   const { call, sent } = setup(() => ({ call_id: "call_0123456789", call_status: "ongoing" }));
//   expect((await call("retell_get_call", { call_id: "call_0123456789" })).json()).toMatchObject({ status: "ongoing", summary: null, note: expect.stringMatching(/hasn't ended/) });
//   expect(sent).toHaveLength(1);
// });
//
// it("checks a pasted key by listing numbers and names the calling number", async () => {
//   const database = createSqliteDatabase();
//   const upstream = async (url: string | URL | Request) => { expect(String(url)).toBe("https://api.retellai.com/list-phone-numbers"); return Response.json(numbers); };
//   const retell = createRetellService({ database: () => database, env: { PEKKA_PLUGIN_KEY: "ab".repeat(32) }, fetch: upstream as typeof fetch });
//   await retell.connect("alice", "key_private");
//   expect(await retell.status("alice")).toMatchObject({ id: "retell", connected: true, enabled: true, workspaceName: "Retell AI, calling from +14155550111" });
//   database.close();
// });
