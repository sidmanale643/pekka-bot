import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { memoryFiles } from "../bot-memory.ts";
import { createBot, DuplicateBotError, findBot, type Bot, type BotProfile } from "../bots.ts";
import { importScheduledJob, type ScheduledJob } from "../scheduler.ts";
import { readSkillFolder, saveSkill, skillExists } from "../skills.ts";
import { ensureSchema, getDatabase, LOCAL_USER, type Database } from "./database.ts";

export interface ImportSummary {
  bots: { imported: number; skipped: number };
  memoryFiles: number;
  skills: { imported: number; skipped: number; errors: string[] };
  jobs: { imported: number; skipped: number };
}

/**
 * The key Pekka derived from the project directory and bot name before bots
 * had stored IDs. Imported bots keep it as their ID, so they reuse the Daytona
 * sandbox they already have.
 */
export function legacyBotKey(bot: BotProfile, projectDirectory = process.cwd()): string {
  return createHash("sha256").update(`${realpathSync(projectDirectory)}\0${bot.name.trim().toLowerCase()}`).digest("hex").slice(0, 24);
}

/**
 * Copies data from the local files Pekka used before D1: bots.json, each bot's
 * memory and skills folders, shared skills, and the scheduler's SQLite file.
 * Records already in the database are left alone, so running it twice is safe.
 * Everything imported belongs to the local user.
 */
export async function importLocalData(database: Database = getDatabase(), projectDirectory = process.cwd()): Promise<ImportSummary> {
  const pekka = join(projectDirectory, ".pekka");
  const summary: ImportSummary = {
    bots: { imported: 0, skipped: 0 }, memoryFiles: 0, skills: { imported: 0, skipped: 0, errors: [] }, jobs: { imported: 0, skipped: 0 },
  };
  await ensureSchema(database);

  const importSkills = async (directory: string, bot?: Bot) => {
    if (!existsSync(directory)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        if (await skillExists(entry.name, { bot, database })) {
          summary.skills.skipped++;
          continue;
        }
        await saveSkill(entry.name, await readSkillFolder(join(directory, entry.name)), { bot, database });
        summary.skills.imported++;
      } catch (error) {
        summary.skills.errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const botsPath = join(pekka, "bots.json");
  if (existsSync(botsPath)) {
    const profiles = z.array(z.object({ name: z.string(), role: z.string(), job: z.string() }))
      .parse(JSON.parse(await readFile(botsPath, "utf8")));
    for (const profile of profiles) {
      const key = legacyBotKey(profile, projectDirectory);
      try {
        await createBot(LOCAL_USER, profile, database, key);
        summary.bots.imported++;
      } catch (error) {
        if (!(error instanceof DuplicateBotError)) throw error;
        summary.bots.skipped++;
      }
      // Only fill in memory and skills for the bot this import created, never for a
      // different bot that happens to share the name.
      const bot = await findBot(LOCAL_USER, profile.name, database);
      if (bot?.id !== key) continue;
      for (const file of memoryFiles) {
        const path = join(pekka, "bots", key, "memory", file);
        if (!existsSync(path)) continue;
        const { changes } = await database.run(
          "INSERT INTO bot_memory (bot_id, file, content, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
          [key, file, await readFile(path, "utf8"), new Date().toISOString()],
        );
        summary.memoryFiles += changes;
      }
      await importSkills(join(pekka, "bots", key, "skills"), bot);
    }
  }

  await importSkills(join(pekka, "skills"));

  const jobsPath = join(pekka, "jobs", "scheduler.sqlite");
  if (existsSync(jobsPath)) {
    const { DatabaseSync } = await import("node:sqlite");
    const local = new DatabaseSync(jobsPath, { readOnly: true });
    try {
      for (const row of local.prepare("SELECT data FROM jobs ORDER BY rowid").all()) {
        const job = JSON.parse(row.data as string) as ScheduledJob;
        // Jobs saved before bot IDs existed only carry the bot's name.
        if (job.bot && !job.bot.id) {
          job.bot.id = (await findBot(LOCAL_USER, job.bot.name, database))?.id ?? legacyBotKey(job.bot, projectDirectory);
        }
        if (await importScheduledJob(job, database)) summary.jobs.imported++;
        else summary.jobs.skipped++;
      }
    } finally {
      local.close();
    }
  }

  return summary;
}
