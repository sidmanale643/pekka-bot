import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BotMemory } from "../bot-memory.ts";
import { createBot, listBots } from "../bots.ts";
import { listScheduledJobs } from "../scheduler.ts";
import { SkillStore } from "../skills.ts";
import { importLocalData, legacyBotKey } from "./import-local.ts";
import { createSqliteDatabase } from "./sqlite.ts";
import { LOCAL_USER } from "./database.ts";

let directory: string;
let database: ReturnType<typeof createSqliteDatabase>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pekka-import-"));
  database = createSqliteDatabase();
});
afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

const skill = async (folder: string, name: string, body: string) => {
  await mkdir(join(folder, name), { recursive: true });
  await writeFile(join(folder, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`);
};

it("copies bots, memory, skills and jobs once, keeping each bot's sandbox key as its ID", async () => {
  const profiles = [{ name: "Scout", role: "Researcher", job: "Research" }, { name: "Writer", role: "Author", job: "Write" }];
  const pekka = join(directory, ".pekka");
  const scoutKey = legacyBotKey(profiles[0]!, directory);
  await mkdir(join(pekka, "jobs"), { recursive: true });
  await writeFile(join(pekka, "bots.json"), JSON.stringify(profiles));
  await mkdir(join(pekka, "bots", scoutKey, "memory"), { recursive: true });
  await writeFile(join(pekka, "bots", scoutKey, "memory", "KNOWLEDGE.md"), "# Knowledge\nImported fact\n");
  await skill(join(pekka, "bots", scoutKey, "skills"), "research", "Scout research");
  await skill(join(pekka, "skills"), "summarize", "Shared summaries");
  await mkdir(join(pekka, "skills", "broken"));

  // Written before bot IDs existed, so the bot snapshot has no ID.
  const job = {
    id: "job-1", name: "Daily", task: "Report", runAt: "2030-01-01T00:00:00.000Z", intervalSeconds: 86_400, bot: profiles[0],
    status: "pending", nextRunAt: "2030-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", runCount: 3, lastRunStatus: "completed",
  };
  const local = new DatabaseSync(join(pekka, "jobs", "scheduler.sqlite"));
  local.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  local.prepare("INSERT INTO jobs (id, data) VALUES (?, ?)").run(job.id, JSON.stringify(job));
  local.close();

  const first = await importLocalData(database, directory);
  expect(first).toMatchObject({
    bots: { imported: 2, skipped: 0 }, memoryFiles: 1, skills: { imported: 2, skipped: 0 }, jobs: { imported: 1, skipped: 0 },
  });
  expect(first.skills.errors).toEqual([expect.stringContaining("broken: A skill needs a SKILL.md file.")]);
  expect(await importLocalData(database, directory)).toMatchObject({
    bots: { imported: 0, skipped: 2 }, memoryFiles: 0, skills: { imported: 0, skipped: 2 }, jobs: { imported: 0, skipped: 1 },
  });

  const bots = await listBots(LOCAL_USER, database);
  expect(bots).toEqual([{ ...profiles[0], id: scoutKey }, { ...profiles[1], id: legacyBotKey(profiles[1]!, directory) }]);
  expect(await new BotMemory(bots[0]!, database).read("KNOWLEDGE.md")).toContain("Imported fact");
  const imported = async (bot: (typeof bots)[number]) =>
    (await new SkillStore(bot, database).catalog()).skills.filter((item) => item.source !== "base").map((item) => item.name);
  expect(await imported(bots[0]!)).toEqual(["research", "summarize"]);
  expect(await imported(bots[1]!)).toEqual(["summarize"]);
  expect(await listScheduledJobs(LOCAL_USER, database)).toEqual([{ ...job, userId: LOCAL_USER, bot: { ...profiles[0], id: scoutKey } }]);
});

it("does not attach local memory to a different bot that already has the same name", async () => {
  const profile = { name: "Scout", role: "Researcher", job: "Research" };
  const existing = await createBot(LOCAL_USER, profile, database);
  const pekka = join(directory, ".pekka");
  const key = legacyBotKey(profile, directory);
  await mkdir(join(pekka, "bots", key, "memory"), { recursive: true });
  await writeFile(join(pekka, "bots.json"), JSON.stringify([profile]));
  await writeFile(join(pekka, "bots", key, "memory", "KNOWLEDGE.md"), "Local only");
  expect(await importLocalData(database, directory)).toMatchObject({ bots: { imported: 0, skipped: 1 }, memoryFiles: 0 });
  expect(await new BotMemory(existing, database).read("KNOWLEDGE.md")).toBe("# Knowledge\n");
});

it("does nothing when there is no local data", async () => {
  expect(await importLocalData(database, directory)).toEqual({
    bots: { imported: 0, skipped: 0 }, memoryFiles: 0, skills: { imported: 0, skipped: 0, errors: [] }, jobs: { imported: 0, skipped: 0 },
  });
});
