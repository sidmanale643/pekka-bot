import { expect, it, vi } from "vitest";
import { createGitHubTools } from "./github.ts";
import { defaultTools } from "./index.ts";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { toToolDefinition } from "./tool.ts";

function setup() {
  const request = vi.fn(async (_userId: string, _path: string, _method: "GET" | "POST" | "PATCH", _data?: unknown) => ({ ok: true }));
  const tools = createGitHubTools({ request });
  const context = { computer: new FakeComputer(), approveAction: async () => true, userId: "tenant-one" };
  async function call(name: string, input: unknown, userId = context.userId) {
    return executeToolCall({ id: "1", type: "function", function: { name, arguments: JSON.stringify(input) } }, tools, { ...context, userId });
  }
  return { request, tools, call };
}

it("registers GitHub tools with bounded schemas and tenant-specific reads", async () => {
  const { tools, request, call } = setup();
  expect(defaultTools.filter((tool) => tool.name.startsWith("github_")).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
  tools.forEach((tool) => expect(toToolDefinition(tool).function.parameters).toHaveProperty("type", "object"));
  expect((await call("github_list_repositories", {})).isError).toBe(false);
  expect(request).toHaveBeenLastCalledWith("tenant-one", "/user/repos?page=1&per_page=30", "GET");
  await call("github_list_pull_requests", { owner: "acme", repo: "project", state: "closed", page: 2, per_page: 100 }, "tenant-two");
  expect(request).toHaveBeenLastCalledWith("tenant-two", "/repos/acme/project/pulls?page=2&per_page=100&state=closed", "GET");
  await call("github_get_repository", { owner: "acme", repo: "project" });
  expect(request).toHaveBeenLastCalledWith("tenant-one", "/repos/acme/project", "GET");
  await call("github_get_issue", { owner: "acme", repo: "project", issue_number: 4 });
  expect(request).toHaveBeenLastCalledWith("tenant-one", "/repos/acme/project/issues/4", "GET");
  await call("github_get_pull_request", { owner: "acme", repo: "project", pull_number: 5 });
  expect(request).toHaveBeenLastCalledWith("tenant-one", "/repos/acme/project/pulls/5", "GET");
  await call("github_list_pull_request_files", { owner: "acme", repo: "project", pull_number: 5 });
  expect(request).toHaveBeenLastCalledWith("tenant-one", "/repos/acme/project/pulls/5/files?page=1&per_page=30", "GET");
  await call("github_list_issue_comments", { owner: "acme", repo: "project", issue_number: 4 });
  expect(request).toHaveBeenLastCalledWith("tenant-one", "/repos/acme/project/issues/4/comments?page=1&per_page=30", "GET");
});

it("rejects traversal, encoded slashes, invalid numbers and excessive pagination before requests", async () => {
  const { request, call } = setup();
  for (const repo of ["..", ".", "../secret", "project%2fissues", "project?state=all", "project#fragment", "project\\secret"]) {
    expect((await call("github_get_repository", { owner: "acme", repo })).isError).toBe(true);
  }
  for (const owner of ["..", "acme/other", "%2e%2e", "acme?x=1"]) {
    expect((await call("github_get_repository", { owner, repo: "project" })).isError).toBe(true);
  }
  for (const issue_number of [0, -1, 1.5, "1/../../secret"]) {
    expect((await call("github_get_issue", { owner: "acme", repo: "project", issue_number })).isError).toBe(true);
  }
  expect((await call("github_list_repositories", { per_page: 101 })).isError).toBe(true);
  expect((await call("github_list_repositories", { page: 0 })).isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it("sends scoped issue, comment and draft pull request payloads without retrying failed writes", async () => {
  const { request, call } = setup();
  await call("github_create_issue", { owner: "acme", repo: "project", title: "Fix button", body: "It is broken" });
  expect(request).toHaveBeenLastCalledWith("tenant-one", "/repos/acme/project/issues", "POST", { title: "Fix button", body: "It is broken" });
  await call("github_add_comment", { owner: "acme", repo: "project", issue_number: 4, body: "Working on it" }, "tenant-two");
  expect(request).toHaveBeenLastCalledWith("tenant-two", "/repos/acme/project/issues/4/comments", "POST", { body: "Working on it" });
  await call("github_create_pull_request", { owner: "acme", repo: "project", title: "Fix button", head: "contributor:fix", base: "main" });
  expect(request).toHaveBeenLastCalledWith("tenant-one", "/repos/acme/project/pulls", "POST", { title: "Fix button", head: "contributor:fix", base: "main", draft: true });
  request.mockRejectedValueOnce(new Error("GitHub plugin is disabled"));
  expect((await call("github_create_issue", { owner: "acme", repo: "project", title: "Fix button" })).isError).toBe(true);
  expect(request).toHaveBeenCalledTimes(4);
});
