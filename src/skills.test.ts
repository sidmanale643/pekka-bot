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
import { readSkillFolder, removeSkill, saveSkill, SkillStore, updateSkill } from "./skills.ts";
import { listSkills, loadSkill, writeSkill } from "./tools/skills.ts";

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
  expect((await scout.catalog()).skills).toEqual([
    { name: "research", description: "Scout's own research.", source: "bot" },
    expect.objectContaining({ name: "skill-creator", source: "base" }),
  ]);
  expect(await scout.read("research", "notes.md")).toBe("Scout notes");
  const writers = new SkillStore(writer, database);
  expect((await writers.catalog()).skills.map((skill) => [skill.name, skill.source])).toEqual([["drafting", "bot"], ["research", "shared"], ["skill-creator", "base"]]);
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
  expect(first).toMatchObject({ total: 4, next_offset: 2, error_count: 1 });
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

it("gives named bots the skills that ship with Pekka, below their own and shared skills", async () => {
  const scout = new SkillStore(bot, database);
  const { skills, errors } = await scout.catalog();
  expect(errors).toEqual([]);
  const creator = skills.find((skill) => skill.name === "skill-creator")!;
  expect(creator).toMatchObject({ source: "base" });
  expect(creator.description.length).toBeLessThanOrEqual(300);
  const instructions = await scout.read("skill-creator", "SKILL.md");
  expect(instructions).toContain("# Skill creator");
  // Loads in one default read.
  expect(instructions.length).toBeLessThan(12_000);
  await expect(scout.read("skill-creator", "missing.md")).rejects.toThrow('has no file "missing.md"');

  // Unnamed runs can't save skills, so they don't get the skill that explains how.
  expect((await new SkillStore(undefined, database).catalog()).skills).toEqual([]);

  await saveSkill("skill-creator", [{ path: "SKILL.md", content: skillDocument("skill-creator", "Shared version", "Shared skill creator.") }], { database });
  expect(await scout.read("skill-creator", "SKILL.md")).toContain("Shared version");
  await updateSkill("skill-creator", [{ path: "SKILL.md", content: skillDocument("skill-creator", "Scout's version", "Scout's skill creator.") }], { bot, database });
  expect(await scout.read("skill-creator", "SKILL.md")).toContain("Scout's version");
  expect((await scout.catalog()).skills).toEqual([{ name: "skill-creator", description: "Scout's skill creator.", source: "bot" }]);
});

it("lets a named bot write its own skills, keeping files it doesn't pass", async () => {
  const writer = await createBot(LOCAL_USER, { name: "Writer", role: "Author", job: "Write" }, database);
  const scout = new SkillStore(bot, database);
  const context = { computer: new FakeComputer(), userId: LOCAL_USER, bot, database, skills: scout };

  const created = JSON.parse(await writeSkill.run({ name: "weekly-update", files: [
    { path: "SKILL.md", content: skillDocument("weekly-update", "Use template.md.", "Draft the weekly update.") },
    { path: "template.md", content: "Template v1" },
  ] }, context));
  expect(created).toEqual({ name: "weekly-update", description: "Draft the weekly update.", saved: ["SKILL.md", "template.md"] });
  expect((await scout.catalog()).skills).toContainEqual({ name: "weekly-update", description: "Draft the weekly update.", source: "bot" });
  expect((await new SkillStore(writer, database).catalog()).skills.map((skill) => skill.name)).not.toContain("weekly-update");

  await writeSkill.run({ name: "weekly-update", files: [{ path: "./template.md", content: "Template v2" }] }, context);
  expect(await scout.read("weekly-update", "template.md")).toBe("Template v2");
  expect(await scout.read("weekly-update", "SKILL.md")).toContain("Use template.md.");

  // A SKILL.md that doesn't match the skill is rejected before anything is written.
  await expect(writeSkill.run({ name: "weekly-update", files: [
    { path: "template.md", content: "Template v3" }, { path: "SKILL.md", content: skillDocument("other") },
  ] }, context)).rejects.toThrow("match");
  expect(await scout.read("weekly-update", "template.md")).toBe("Template v2");

  // A shared skill of the same name doesn't count: the bot's own copy needs its SKILL.md.
  await saveSkill("research", [{ path: "SKILL.md", content: skillDocument("research") }], { database });
  await expect(writeSkill.run({ name: "research", files: [{ path: "notes.md", content: "Notes" }] }, context)).rejects.toThrow("needs a SKILL.md");
  await expect(writeSkill.run({ name: "notes", files: [{ path: "../escape.md", content: "x" }, { path: "SKILL.md", content: skillDocument("notes") }] }, context))
    .rejects.toThrow("inside its skill folder");
  await expect(writeSkill.run({ name: "notes", files: [{ path: "SKILL.md", content: skillDocument("notes") }] }, { ...context, bot: undefined }))
    .rejects.toThrow("named bots");
  expect((await new SkillStore(undefined, database).catalog()).skills.map((skill) => skill.name)).toEqual(["research"]);
});

it("tells named bots how to write skills and points them at skill-creator", async () => {
  let prompt = "";
  let tools: string[] = [];
  await runAgent("Save how we do the weekly update", {
    bot, database, computer: new FakeComputer(), userId: LOCAL_USER, tools: [listSkills, loadSkill, writeSkill], maxSteps: 1,
    model: { async reply(messages, definitions) {
      prompt = messages[0]!.content!;
      tools = definitions.map((definition) => definition.function.name);
      return { message: { role: "assistant" as const, content: "Done" }, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } };
    } },
  });
  expect(tools).toEqual(["list_skills", "load_skill", "write_skill"]);
  expect(prompt).toContain('"name":"skill-creator"');
  expect(prompt).toContain("load skill-creator and follow it before using write_skill");
});
