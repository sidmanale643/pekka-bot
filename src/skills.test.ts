import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runAgent } from "./agent/loop.ts";
import { executeToolCall } from "./agent/execute-tool-call.ts";
import { createBot, type Bot } from "./bots.ts";
import { FakeComputer } from "./computer/fake-computer.ts";
import { ensureSchema, LOCAL_USER } from "./database/database.ts";
import { createSqliteDatabase } from "./database/sqlite.ts";
import { readSkillFolder, removeSkill, saveSkill, SkillStore } from "./skills.ts";
import { listSkills, loadSkill } from "./tools/skills.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let directory: string;
let bot: Bot;
beforeEach(async () => {
  database = createSqliteDatabase();
  directory = await mkdtemp(join(tmpdir(), "pekka-skills-"));
  bot = await createBot(LOCAL_USER, { name: "Scout", role: "Researcher", job: "Research" }, database);
});
afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

const skillDocument = (name: string, body = "Detailed instructions only revealed on demand", description = "Research repositories and write a report.") =>
  `---\nname: ${name}\ndescription: >\n  ${description}\n---\n${body}\n`;

it("discloses summaries, then selected instructions, then supporting files through agent tools", async () => {
  await saveSkill("research", [
    { path: "SKILL.md", content: skillDocument("research", "Detailed instructions only revealed on demand. Consult references/format.md.") },
    { path: "references/format.md", content: "Supporting format only revealed later" },
  ], { database });
  let step = 0;
  const result = await runAgent("Research repositories", {
    bot, database, computer: new FakeComputer(), userId: LOCAL_USER, tools: [listSkills, loadSkill], maxSteps: 3,
    model: { async reply(messages) {
      step++;
      const initial = messages[0]!.content!;
      expect(initial).toContain("Research repositories and write a report.");
      expect(initial).not.toContain("Detailed instructions only revealed on demand");
      expect(initial).not.toContain("Supporting format only revealed later");
      if (step === 2) {
        expect(JSON.parse(messages.at(-1)!.content!).content).toContain("Detailed instructions only revealed on demand");
        expect(messages.some((message) => message.content?.includes("Supporting format only revealed later"))).toBe(false);
      }
      if (step === 3) expect(JSON.parse(messages.at(-1)!.content!).content).toBe("Supporting format only revealed later");
      return {
        message: step < 3 ? {
          role: "assistant" as const, content: null,
          tool_calls: [{ id: `load-${step}`, type: "function" as const, function: {
            name: "load_skill", arguments: JSON.stringify({ name: "research", ...(step === 2 ? { file: "./references/format.md" } : {}) }),
          } }],
        } : { role: "assistant" as const, content: "Done" },
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      };
    } },
  });
  expect(result.status).toBe("done");
});

it("shares skills with every bot and lets a bot's own skill replace a shared one", async () => {
  const writer = await createBot(LOCAL_USER, { name: "Writer", role: "Author", job: "Write" }, database);
  await saveSkill("research", [{ path: "SKILL.md", content: skillDocument("research", "Shared body", "Shared research.") }], { database });
  await saveSkill("research", [
    { path: "SKILL.md", content: skillDocument("research", "Scout body", "Scout's own research.") },
    { path: "notes.md", content: "Scout notes" },
  ], { bot, database });
  await saveSkill("drafting", [{ path: "SKILL.md", content: skillDocument("drafting", "Draft", "Drafting.") }], { bot: writer, database });

  const scout = new SkillStore(bot, database);
  expect((await scout.catalog()).skills).toEqual([{ name: "research", description: "Scout's own research." }]);
  expect(await scout.read("research", "notes.md")).toBe("Scout notes");
  const writers = new SkillStore(writer, database);
  expect((await writers.catalog()).skills.map((skill) => skill.name)).toEqual(["drafting", "research"]);
  expect(await writers.read("research", "SKILL.md")).toContain("Shared body");
  // A shared skill's files never mix with a bot's own version of the same skill.
  await expect(writers.read("research", "notes.md")).rejects.toThrow('has no file "notes.md"');
  expect((await new SkillStore(undefined, database).catalog()).skills.map((skill) => skill.name)).toEqual(["research"]);

  await removeSkill("research", { bot, database });
  expect(await scout.read("research", "SKILL.md")).toContain("Shared body");
  await expect(removeSkill("research", { bot, database })).rejects.toThrow("No skill");
});

it("replaces every file when a skill is saved again and validates it first", async () => {
  await saveSkill("research", [
    { path: "SKILL.md", content: skillDocument("research") },
    { path: "old.md", content: "Old" },
  ], { database });
  await saveSkill("research", [{ path: "SKILL.md", content: skillDocument("research", "New") }], { database });
  const store = new SkillStore(undefined, database);
  await expect(store.read("research", "old.md")).rejects.toThrow();
  await expect(saveSkill("research", [{ path: "notes.md", content: "No SKILL.md" }], { database })).rejects.toThrow("needs a SKILL.md");
  await expect(saveSkill("other", [{ path: "SKILL.md", content: skillDocument("research") }], { database })).rejects.toThrow("match");
  await expect(saveSkill("research", [
    { path: "SKILL.md", content: skillDocument("research") }, { path: "../escape.md", content: "x" },
  ], { database })).rejects.toThrow("inside its skill folder");
  expect(await store.read("research", "SKILL.md")).toContain("New");
});

it("reports malformed skills while paginating every valid summary and long file", async () => {
  for (let index = 0; index < 3; index++) {
    await saveSkill(`skill-${index}`, [{ path: "SKILL.md", content: skillDocument(`skill-${index}`, "x".repeat(25000)) }], { database });
  }
  await ensureSchema(database);
  await database.run("INSERT INTO skill_files (scope, skill, path, content, revision) VALUES ('', 'broken', 'SKILL.md', 'No frontmatter', 'r')");
  const store = new SkillStore(bot, database);
  const context = { computer: new FakeComputer(), userId: LOCAL_USER, skills: store };
  const first = JSON.parse(await listSkills.run({ offset: 0, limit: 2 }, context));
  expect(first).toMatchObject({ total: 3, next_offset: 2, error_count: 1 });
  expect(first.skills.map((entry: { name: string }) => entry.name)).toEqual(["skill-0", "skill-1"]);
  expect(JSON.parse(await listSkills.run({ offset: first.next_offset, limit: 2 }, context)).skills[0].name).toBe("skill-2");
  let offset: number | null = 0;
  let combined = "";
  while (offset !== null) {
    const chunk = JSON.parse(await loadSkill.run({ name: "skill-0", file: "SKILL.md", offset, limit: 12000 }, context));
    combined += chunk.content;
    offset = chunk.next_offset;
  }
  expect(combined).toBe(await store.read("skill-0", "SKILL.md"));
});

it("rejects paths outside the skill and never reads another skill's files", async () => {
  await saveSkill("research", [{ path: "SKILL.md", content: skillDocument("research") }], { database });
  await saveSkill("private", [
    { path: "SKILL.md", content: skillDocument("private") }, { path: "secret.md", content: "Private data" },
  ], { database });
  const store = new SkillStore(bot, database);
  for (const file of ["../private/secret.md", "/secret.md", "secret.md"]) {
    const result = await executeToolCall({ id: "bad", type: "function", function: {
      name: "load_skill", arguments: JSON.stringify({ name: "research", file }),
    } }, [loadSkill], { computer: new FakeComputer(), userId: LOCAL_USER, skills: store });
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("Private data");
  }
  await expect(store.read("../research", "SKILL.md")).rejects.toThrow();
});

it("reads a local skill folder, skipping symbolic links and rejecting binary files", async () => {
  const folder = join(directory, "research");
  await mkdir(join(folder, "references"), { recursive: true });
  await writeFile(join(folder, "SKILL.md"), skillDocument("research"));
  await writeFile(join(folder, "references", "format.md"), "Format");
  await writeFile(join(directory, "private.txt"), "Private data");
  await symlink(join(directory, "private.txt"), join(folder, "linked.txt"));
  const files = await readSkillFolder(folder);
  expect(files.map((file) => file.path).sort()).toEqual(["SKILL.md", "references/format.md"]);
  await writeFile(join(folder, "image.png"), Buffer.from([137, 80, 0, 71]));
  await expect(readSkillFolder(folder)).rejects.toThrow("image.png is not a text file");
});
