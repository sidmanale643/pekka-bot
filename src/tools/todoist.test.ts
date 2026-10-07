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
    .toEqual(["todoist_create_task", "todoist_update_task", "todoist_complete_task", "todoist_reopen_task", "todoist_add_comment"]);
});

it("lists Todoist tasks by filter or by scope", async () => {
  const { sent, call } = setup();
  await call("todoist_list_tasks", { filter: "today | overdue" });
  await call("todoist_list_tasks", { project_id: "6Jf8VQXxpwv56VQ7", label: "work", limit: 10 });
  expect(sent.map(({ path }) => path)).toEqual(["/tasks/filter?query=today+%7C+overdue&limit=50", "/tasks?project_id=6Jf8VQXxpwv56VQ7&label=work&limit=10"]);
});

it("sends Todoist writes with only the fields given, and links to the task", async () => {
  const { sent, call } = setup();
  const created = await call("todoist_create_task", { content: "Buy milk", due_string: "tomorrow 5pm", priority: 4 });
  expect(created.json()).toMatchObject({ url: "https://app.todoist.com/app/task/6X7rM8997g3RQmvh" });
  await call("todoist_update_task", { task_id: "6X7rM8997g3RQmvh", labels: ["errands"] });
  await call("todoist_complete_task", { task_id: "6X7rM8997g3RQmvh" });
  expect(sent).toEqual([
    { path: "/tasks", init: { method: "POST", body: { content: "Buy milk", due_string: "tomorrow 5pm", priority: 4 } } },
    { path: "/tasks/6X7rM8997g3RQmvh", init: { method: "POST", body: { labels: ["errands"] } } },
    { path: "/tasks/6X7rM8997g3RQmvh/close", init: { method: "POST" } },
  ]);
});

it("rejects bad ids and empty updates before calling the service", async () => {
  const { sent, call } = setup();
  for (const [name, args] of [
    ["todoist_update_task", { task_id: "6X7rM8997g3RQmvh" }],
    ["todoist_complete_task", { task_id: "../projects" }],
    ["todoist_create_task", { content: "x", priority: 5 }],
    ["granola_get_note", { note_id: "not_short" }],
  ] as const) {
    expect((await call(name, args)).isError).toBe(true);
  }
  expect(sent).toEqual([]);
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
