import { expect, it } from "vitest";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";
import type { LinearOperation } from "../plugins/linear.ts";
import { defaultTools } from "./index.ts";
import { createLinearTools } from "./linear.ts";

const TEAM = "9cfb482a-81e3-4154-b5b9-2c805e70a02d";
const STATE = "1f0c5a8e-3b2d-4c6e-9a7f-0d1e2f3a4b5c";

function setup() {
  const sent: { operation: LinearOperation; variables: Record<string, unknown> }[] = [];
  const tools = createLinearTools({ async request(_userId, operation, variables = {}) { sent.push({ operation, variables }); return { ok: true }; } });
  const context = { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER };
  const call = (name: string, args: unknown) => executeToolCall({ id: "1", type: "function", function: { name, arguments: JSON.stringify(args) } }, tools, context);
  return { tools, sent, call };
}

it("registers every Linear tool for bots, under the linear plugin", () => {
  const { tools } = setup();
  expect(defaultTools.filter((tool) => tool.name.startsWith("linear_")).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
  expect(tools.every((tool) => tool.permission?.plugin === "linear")).toBe(true);
  expect(tools.filter((tool) => tool.permission?.effect === "write").map((tool) => tool.name)).toEqual(["linear_create_issue", "linear_update_issue", "linear_add_comment"]);
});

it("turns list filters into Linear's issue filter", async () => {
  const { sent, call } = setup();
  await call("linear_list_issues", {});
  await call("linear_list_issues", { team_id: TEAM, assigned_to_me: true, state: "started", first: 10, after: "cursor" });
  await call("linear_list_issues", { state: "all" });
  expect(sent.map(({ variables }) => variables)).toEqual([
    { filter: { state: { type: { nin: ["completed", "canceled"] } } }, first: 25 },
    { filter: { team: { id: { eq: TEAM } }, assignee: { isMe: { eq: true } }, state: { type: { eq: "started" } } }, first: 10, after: "cursor" },
    { filter: {}, first: 25 },
  ]);
});

it("maps writes to Linear's inputs and accepts issue identifiers", async () => {
  const { sent, call } = setup();
  expect((await call("linear_create_issue", { team_id: TEAM, title: "Fix login", description: "Steps", priority: 2, state_id: STATE })).isError).toBe(false);
  expect((await call("linear_update_issue", { issue: "eng-42", state_id: STATE })).isError).toBe(false);
  expect((await call("linear_add_comment", { issue_id: TEAM, body: "Done" })).isError).toBe(false);
  expect(sent).toEqual([
    { operation: "createIssue", variables: { input: { teamId: TEAM, title: "Fix login", description: "Steps", priority: 2, stateId: STATE } } },
    { operation: "updateIssue", variables: { id: "eng-42", input: { stateId: STATE } } },
    { operation: "createComment", variables: { input: { issueId: TEAM, body: "Done" } } },
  ]);
});

it("rejects malformed ids and empty updates before calling Linear", async () => {
  const { sent, call } = setup();
  for (const [name, args] of [
    ["linear_update_issue", { issue: "ENG-42" }],
    ["linear_get_issue", { issue: "ENG-42/../teams" }],
    ["linear_create_issue", { team_id: "ENG", title: "x" }],
    ["linear_add_comment", { issue_id: "ENG-42", body: "x" }],
    ["linear_update_issue", { issue: "ENG-42", priority: 9 }],
  ] as const) {
    expect((await call(name, args)).isError).toBe(true);
  }
  expect(sent).toEqual([]);
});
