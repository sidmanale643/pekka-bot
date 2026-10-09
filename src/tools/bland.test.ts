import { expect, it } from "vitest";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { createBlandService } from "../plugins/bland.ts";
import { createBlandTools } from "./bland.ts";
import { defaultTools } from "./index.ts";

type Sent = { path: string; init?: { method?: string; body?: unknown } };
const CALL_ID = "9d404c1b-6a23-4426-953a-a52c392ff8f1";

function setup(reply: (path: string, count: number) => unknown = () => ({ status: "success", message: "Call successfully queued.", call_id: CALL_ID, batch_id: null })) {
  const sent: Sent[] = [];
  const service = { async request(_userId: string, path: string, init?: Sent["init"]) { sent.push({ path, ...(init ? { init } : {}) }); return reply(path, sent.length); } };
  const tools = createBlandTools(service, { pollMs: 1 });
  const context = { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER };
  const call = async (name: string, args: unknown) => {
    const result = await executeToolCall({ id: "1", type: "function", function: { name, arguments: JSON.stringify(args) } }, tools, context);
    return { ...result, json: () => JSON.parse(result.output) };
  };
  return { tools, sent, call };
}

it("registers the Bland tools under their plugin, with only placing a call as a write", () => {
  const { tools } = setup();
  expect(defaultTools.filter((tool) => tool.name.startsWith("bland_")).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
  expect(tools.every((tool) => tool.permission?.plugin === "bland")).toBe(true);
  expect(tools.filter((tool) => tool.permission?.effect === "write").map((tool) => tool.name)).toEqual(["bland_call"]);
});

it("calls from Bland's shared pool by default, with the task as the agent's instructions and a ten-minute cap", async () => {
  const { call, sent } = setup();
  const result = (await call("bland_call", { to_number: "+14155550199", task: "You are calling Luigi's for Sam to book a table for four at 7pm Friday." })).json();
  expect(result).toMatchObject({ call_id: CALL_ID, status: "queued", from_number: "Bland's shared pool", to_number: "+14155550199" });
  expect(sent).toEqual([{ path: "/v1/calls", init: { method: "POST", body: {
    phone_number: "+14155550199", task: "You are calling Luigi's for Sam to book a table for four at 7pm Friday.", max_duration: 10, metadata: { source: "pekka" },
  } } }]);
});

it("passes a chosen number, opening line, voice and time limit", async () => {
  const { call, sent } = setup();
  await call("bland_call", { to_number: "+442071234567", task: "Confirm the delivery.", first_sentence: "Hi, I'm calling about a delivery.", from_number: "+14155550100", voice: "Josh", max_duration_minutes: 3 });
  expect(sent[0]!.init!.body).toMatchObject({ from: "+14155550100", first_sentence: "Hi, I'm calling about a delivery.", voice: "Josh", max_duration: 3 });
});

it("refuses badly formed numbers and explains when Bland doesn't start the call", async () => {
  const bad = setup();
  expect((await bad.call("bland_call", { to_number: "415-555-0199", task: "Hi" })).output).toMatch(/E\.164/);
  expect(bad.sent).toEqual([]);
  const { call } = setup(() => ({ status: "error", message: "Insufficient balance" }));
  expect((await call("bland_call", { to_number: "+14155550199", task: "Hi" })).output).toMatch(/didn't start the call: Insufficient balance/);
});

it("waits for a call to end and returns Bland's summary and transcript", async () => {
  const { call, sent } = setup((_path, count) => count < 3
    ? { queue_status: count === 1 ? "queued" : "started", completed: false }
    : { status: "completed", queue_status: "complete", completed: true, to: "+14155550199", from: "+17163511654", call_length: 1.39, answered_by: "human", call_ended_by: "ASSISTANT", error_message: null, summary: "Table booked for 7pm.", price: 0.19, recording_url: null, concatenated_transcript: "assistant: Hi \n user: Hello" });
  const result = (await call("bland_get_call", { call_id: CALL_ID, wait_seconds: 5 })).json();
  expect(sent.map(({ path }) => path)).toEqual(Array(3).fill(`/v1/calls/${CALL_ID}`));
  expect(result).toMatchObject({ status: "completed", from_number: "+17163511654", answered_by: "human", duration_seconds: 83, ended_by: "ASSISTANT", summary: "Table booked for 7pm.", cost_usd: 0.19, transcript: "assistant: Hi \n user: Hello", next_offset: null });
  expect(result.note).toBeUndefined();
});

it("says when a call is still going instead of waiting by default, and reports calls that failed", async () => {
  const going = setup(() => ({ queue_status: "started", completed: false }));
  expect((await going.call("bland_get_call", { call_id: CALL_ID })).json()).toMatchObject({ status: "started", summary: null, note: expect.stringMatching(/hasn't ended/) });
  expect(going.sent).toHaveLength(1);
  const failed = setup(() => ({ status: "failed", queue_status: "queue_error", completed: false, error_message: "The number you dialed is not found." }));
  const result = (await failed.call("bland_get_call", { call_id: CALL_ID, wait_seconds: 5 })).json();
  expect(failed.sent).toHaveLength(1);
  expect(result).toMatchObject({ status: "failed", error: "The number you dialed is not found." });
  expect(result.note).toBeUndefined();
});

it("checks a pasted key against the account endpoint", async () => {
  const database = createSqliteDatabase();
  const upstream = async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.bland.ai/v1/me");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer org_private");
    return Response.json({ status: "active", billing: { current_balance: 2, refill_to: null }, total_calls: 0 });
  };
  const bland = createBlandService({ database: () => database, env: { PEKKA_PLUGIN_KEY: "ab".repeat(32) }, fetch: upstream as typeof fetch });
  await bland.connect("alice", "org_private");
  expect(await bland.status("alice")).toMatchObject({ id: "bland", connected: true, enabled: true, workspaceName: "your Bland AI account" });
  database.close();
});
