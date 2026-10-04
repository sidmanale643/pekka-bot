import { afterEach, describe, expect, it } from "vitest";
import { systemPrompt } from "../agent/system-prompt.ts";
import { BotMemory } from "../bot-memory.ts";
import { createBot } from "../bots.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { readMemory } from "./bot-memory.ts";
import { defaultTools, unnamedTools } from "./index.ts";
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

it("tells the agent how many steps it has", () => {
  expect(systemPrompt(undefined, 12)).toContain("You have 12 steps.");
});
