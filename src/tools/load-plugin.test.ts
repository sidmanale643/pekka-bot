import { expect, it } from "vitest";
import { systemPrompt } from "../agent/system-prompt.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";
import { chiefTools, defaultTools, withPlugins } from "./index.ts";
import { createPluginLoader, PLUGINS } from "./load-plugin.ts";

const context = { computer: new FakeComputer(), userId: LOCAL_USER };
const names = (loader: ReturnType<typeof createPluginLoader>) => loader.tools().map((tool) => tool.name);

it("describes every plugin a tool belongs to", () => {
  const plugins = new Set(chiefTools.flatMap((tool) => tool.permission?.plugin ?? []));
  expect([...plugins].filter((id) => !PLUGINS.some((info) => info.id === id))).toEqual([]);
});

it("starts with built-in tools and load_plugin, and adds a plugin's tools when it is loaded", async () => {
  const loader = createPluginLoader(withPlugins(defaultTools, new Set(["gmail", "github"])));
  const builtIn = defaultTools.filter((tool) => !tool.permission?.plugin).map((tool) => tool.name);
  expect(names(loader)).toEqual([...builtIn, "load_plugin"]);
  expect(loader.plugins.map(({ id }) => id)).toEqual(["gmail", "github"]);
  expect(loader.definitions().map((definition) => definition.function.name)).toEqual(names(loader));

  const load = loader.tools().find((tool) => tool.name === "load_plugin")!;
  const result = JSON.parse(await load.run({ plugin: "github" }, context));
  expect(result).toMatchObject({ plugin: "github", name: "GitHub", tools: expect.arrayContaining(["github_create_issue"]), guidance: expect.stringContaining("Pull requests default to drafts") });
  expect(names(loader)).toEqual([...builtIn, "load_plugin", ...result.tools]);
  expect(loader.definitions().map((definition) => definition.function.name)).toEqual(names(loader));

  // Loading again changes nothing.
  expect(JSON.parse(await load.run({ plugin: "github" }, context))).toMatchObject({ already_loaded: true });
  expect(names(loader)).toEqual([...builtIn, "load_plugin", ...result.tools]);
});

it("only offers the run's own plugins", async () => {
  const loader = createPluginLoader(withPlugins(defaultTools, new Set(["gmail"])));
  const load = loader.tools().find((tool) => tool.name === "load_plugin")!;
  await expect(load.run({ plugin: "github" }, context)).rejects.toThrow();
  expect(loader.pluginOf("gmail_send")).toBe("gmail");
  expect(loader.pluginOf("github_create_issue")).toBeUndefined();
  expect(loader.pluginOf("run_command")).toBeUndefined();
});

it("leaves out load_plugin when no plugin is set up", () => {
  const loader = createPluginLoader(withPlugins(defaultTools, new Set()));
  expect(names(loader)).not.toContain("load_plugin");
  expect(loader.plugins).toEqual([]);
});

it("keeps a plugin that isn't enabled out of everything the agent sees", async () => {
  const mentions: Record<string, RegExp> = {
    agentmail: /agentmail|get_email_address|send_email|own mailbox/i, gmail: /gmail/i, calendar: /calendar_|tasks_|google calendar|google tasks|reminder/i,
    drive: /\bdrive\b|docs_|sheets_|google docs|spreadsheet/i, contacts: /contacts/i, notion: /notion/i, github: /github|pull request/i, linear: /linear/i, granola: /granola/i, wispr: /wispr/i, todoist: /todoist/i, telegram: /telegram/i,
  };
  expect(Object.keys(mentions).sort()).toEqual(PLUGINS.map(({ id }) => id).sort());
  const chief = { id: "b", name: "Scout", role: "Helps with research", job: "", primary: true } as never;

  for (const hidden of PLUGINS.map(({ id }) => id)) {
    const others = new Set(PLUGINS.map(({ id }) => id).filter((id) => id !== hidden));
    const loader = createPluginLoader(withPlugins(chiefTools, others));
    const load = loader.tools().find((tool) => tool.name === "load_plugin")!;
    const results = await Promise.all([...others].map((plugin) => load.run({ plugin }, context)));
    const seen = [systemPrompt(chief, 30, { plugins: loader.plugins }), JSON.stringify(loader.definitions()), ...results].join("\n");
    expect(seen.match(mentions[hidden]!)?.[0], `${hidden} leaked`).toBeUndefined();
  }

  const nothing = [systemPrompt(chief, 30), JSON.stringify(createPluginLoader(withPlugins(chiefTools, new Set())).definitions())].join("\n");
  expect(nothing).not.toMatch(/plugin/i);
  for (const pattern of Object.values(mentions)) expect(nothing).not.toMatch(pattern);
});
