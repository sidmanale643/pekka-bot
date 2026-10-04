import { afterEach, describe, expect, it } from "vitest";
import { systemPrompt } from "../agent/system-prompt.ts";
import { BotMemory } from "../bot-memory.ts";
import { createBot } from "../bots.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { readMemory } from "./bot-memory.ts";
import { chiefTools, defaultTools, unnamedTools, withPlugins, withServerKeys } from "./index.ts";
import { createPluginLoader } from "./load-plugin.ts";
import { readFile } from "./read-file.ts";
import { runCommand } from "./run-command.ts";

const databases: ReturnType<typeof createSqliteDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach((database) => database.close()); });

function withFile(content: string) {
  const computer = new FakeComputer();
  computer.files.set("notes.md", content);
  return { computer, userId: LOCAL_USER };
}

describe("read_file", () => {
  it("returns a file that fits exactly as saved", async () => {
    expect(await readFile.run({ path: "notes.md", offset: 1 }, withFile("one\ntwo\n"))).toBe("one\ntwo\n");
  });

  it("pages through a long file by line and says where to continue", async () => {
    const lines = Array.from({ length: 3000 }, (_, index) => `line ${index + 1} ${"x".repeat(20)}`);
    const context = withFile(`${lines.join("\n")}\n`);
    const first = await readFile.run({ path: "notes.md", offset: 1 }, context);
    const next = Number(/Read from offset (\d+)/.exec(first)![1]);
    expect(first.startsWith("line 1 ")).toBe(true);
    expect(first).toContain(`[Lines 1-${next - 1} of 3000.`);
    expect(first.length).toBeLessThan(20_200);
    const second = await readFile.run({ path: "notes.md", offset: next, limit: 2 }, context);
    expect(second).toBe(`${lines[next - 1]}\n${lines[next]}\n\n[Lines ${next}-${next + 1} of 3000. Read from offset ${next + 2} for more.]`);
    expect(await readFile.run({ path: "notes.md", offset: 2999 }, context)).toBe(`${lines[2998]}\n${lines[2999]}`);
  });

  it("rejects an offset past the end of the file", async () => {
    await expect(readFile.run({ path: "notes.md", offset: 5 }, withFile("one\ntwo\n"))).rejects.toThrow("has 2 lines");
  });
});

it("keeps the end of long command output, where failures are reported", async () => {
  const computer = new FakeComputer({ "pnpm test": { exitCode: 1, output: `${"progress\n".repeat(5000)}FAILED: 3 tests` } });
  const output = await runCommand.run({ command: "pnpm test" }, { computer, userId: LOCAL_USER });
  expect(output.startsWith("exit code: 1\nprogress")).toBe(true);
  expect(output).toContain("characters omitted from the middle");
  expect(output.endsWith("FAILED: 3 tests")).toBe(true);
});

it("tells the agent which memory offset to read next", async () => {
  const database = createSqliteDatabase();
  databases.push(database);
  const memory = new BotMemory(await createBot(LOCAL_USER, { name: "Scout", role: "Research", job: "" }, database), database);
  await memory.write("KNOWLEDGE.md", `${"a".repeat(25_000)}END`);
  const context = { computer: new FakeComputer(), userId: LOCAL_USER, memory };
  const first = await readMemory.run({ file: "KNOWLEDGE.md", offset: 0 }, context);
  expect(first).toContain("[Truncated. Read from offset 20000 for the rest.]");
  expect(await readMemory.run({ file: "KNOWLEDGE.md", offset: 20_000 }, context)).toBe(`${"a".repeat(5_000)}END`);
});

it("leaves tools that need a named bot out of unnamed runs", () => {
  const named = ["read_memory", "write_memory", "update_bot_config", "write_skill", "get_email_address", "send_email"];
  expect(defaultTools.map((tool) => tool.name)).toEqual(expect.arrayContaining(named));
  expect(unnamedTools.map((tool) => tool.name)).toEqual(defaultTools.map((tool) => tool.name).filter((name) => !named.includes(name)));
});

it("only gives a run the tools of plugins that are set up", () => {
  const names = (plugins: string[]) => withPlugins(chiefTools, new Set(plugins)).map((tool) => tool.name);
  const core = chiefTools.filter((tool) => !tool.permission?.plugin).map((tool) => tool.name);
  expect(names([])).toEqual(core);
  expect(names(["gmail"])).toEqual(expect.arrayContaining([...core, "gmail_search", "gmail_send"]));
  expect(names(["gmail"]).filter((name) => !core.includes(name)).every((name) => name.startsWith("gmail_"))).toBe(true);
});

it("lists only the run's own plugins, with their tools", () => {
  expect(systemPrompt(undefined, 30)).not.toContain("# Acting outside your computer");

  const some = systemPrompt(undefined, 30, { plugins: createPluginLoader(withPlugins(defaultTools, new Set(["gmail", "agentmail"]))).plugins });
  expect(some).toContain("call load_plugin with a plugin's id");
  expect(some).toContain("- agentmail (Email): Your own mailbox, for sending email as yourself. Tools: get_email_address, send_email.");
  expect(some).toMatch(/- gmail \(Gmail\): .+ Tools: gmail_search, gmail_read_message, .+, gmail_modify_labels\./);
  // Guidance arrives with load_plugin, not up front.
  expect(some).not.toContain("gmail_send sends as the user");
  expect(some).not.toMatch(/calendar|notion|github|telegram|not connected/i);
  expect(some).toContain("These are your only plugins.");
});

it("leaves out web tools the server has no key for, and the prompt follows", () => {
  const names = (env: NodeJS.ProcessEnv) => withServerKeys(defaultTools, env).map((tool) => tool.name);
  expect(names({ EXA_API_KEY: "k", SCRAPERAPI_API_KEY: "k" })).toEqual(expect.arrayContaining(["web_search", "web_scrape"]));
  expect(names({ TAVILY_API_KEY: "k" })).not.toContain("web_scrape");
  expect(names({ SCRAPERAPI_API_KEY: " " })).not.toEqual(expect.arrayContaining(["web_search"]));
  expect(names({})).toEqual(defaultTools.map((tool) => tool.name).filter((name) => name !== "web_search" && name !== "web_scrape"));

  const prompt = (tools: string[]) => systemPrompt(undefined, 30, { tools: new Set(tools) });
  expect(prompt(["web_search", "web_scrape"])).toContain("Use web_search for current or unfamiliar facts, and web_scrape to read a source.");
  expect(prompt(["web_search"])).toContain("- Use web_search for current or unfamiliar facts.\n");
  expect(prompt(["web_search"])).not.toContain("web_scrape");
  expect(prompt(["web_scrape"])).not.toContain("web_search");
  expect(prompt([])).not.toContain("# Research");
});

it("only explains skills to a run that has the skill tools", () => {
  expect(systemPrompt(undefined, 30, { tools: new Set(["load_skill", "list_skills"]) })).toContain("# Skills");
  expect(systemPrompt(undefined, 30, { tools: new Set(["run_command"]) })).not.toMatch(/# Skills|load_skill|list_skills/);
});

it("tells the agent how many steps it has", () => {
  expect(systemPrompt(undefined, 12)).toContain("You have 12 steps.");
});
