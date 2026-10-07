import { expect, it } from "vitest";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";
import { createGranolaTools } from "./granola.ts";
import { defaultTools } from "./index.ts";
import { createTodoistTools } from "./todoist.ts";

type Sent = { path: string; init?: { method?: string; body?: unknown } };

function setup(reply: (path: string) => unknown = () => ({ id: "6X7rM8997g3RQmvh", content: "Buy milk" })) {
  const sent: Sent[] = [];
  const service = { async request(_userId: string, path: string, init?: Sent["init"]) { sent.push({ path, ...(init ? { init } : {}) }); return reply(path); } };
  const tools = [...createGranolaTools(service), ...createTodoistTools(service)];
  const context = { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER };
  const call = async (name: string, args: unknown) => {
    const result = await executeToolCall({ id: "1", type: "function", function: { name, arguments: JSON.stringify(args) } }, tools, context);
    return { ...result, json: () => JSON.parse(result.output) };
  };
  return { tools, sent, call };
}

it("registers every Todoist and Granola tool under its plugin, with only Todoist writing", () => {
  const { tools } = setup();
  const names = tools.map((tool) => tool.name);
  expect(defaultTools.filter((tool) => /^(todoist|granola)_/.test(tool.name)).map((tool) => tool.name)).toEqual(names);
  expect(tools.every((tool) => tool.permission?.plugin === tool.name.split("_")[0])).toBe(true);
  expect(tools.filter((tool) => tool.permission?.effect === "write").map((tool) => tool.name))
    .toEqual(["todoist_write_tool"]);
});

it("pages through a Granola transcript as speaker lines", async () => {
  const transcript = Array.from({ length: 200 }, (_, index) => ({ speaker: index % 2 ? { source: "speaker", attribution: "them" } : { source: "microphone", name: "Ada" }, text: `line ${index} `.repeat(10) }));
  const { sent, call } = setup(() => ({ title: "Standup", transcript }));
  const first = (await call("granola_get_transcript", { note_id: "not_1d3tmYTlCICgjy" })).json();
  expect(sent[0]!.path).toBe("/v1/notes/not_1d3tmYTlCICgjy?include=transcript");
  expect(first.transcript.startsWith("Ada: line 0")).toBe(true);
  expect(first.transcript).toContain("\nThem: line 1");
  expect(first.next_offset).toBe(15_000);
  const last = (await call("granola_get_transcript", { note_id: "not_1d3tmYTlCICgjy", offset: first.next_offset })).json();
  expect(last.next_offset).toBeNull();
  expect(first.transcript.length + last.transcript.length).toBe(first.total_characters);
});

it("routes reads and writes through MCP with the correct access mode", async () => {
  const calls: unknown[][] = [];
  const tools: import("./tool.ts").Tool[] = createTodoistTools({ async request(...args) { calls.push(args); return { content: [] }; } });
  const context = { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER };
  await tools[0]!.run({}, context);
  await tools[1]!.run({ name: "find-tasks", arguments: { search: "milk" } }, context);
  await tools[2]!.run({ name: "add-tasks", arguments: {} }, context);
  expect(calls).toEqual([[LOCAL_USER, undefined, {}, undefined], [LOCAL_USER, "find-tasks", { search: "milk" }, undefined, true], [LOCAL_USER, "add-tasks", {}, undefined, false]]);
});
