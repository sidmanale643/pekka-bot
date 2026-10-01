import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Bot } from "./bots.ts";
import { ensureSchema, getDatabase, type Database } from "./database/database.ts";

export const skillName = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const metadataSchema = z.object({ name: skillName, description: z.string().trim().min(1).max(1024) });
export type SkillSummary = z.infer<typeof metadataSchema>;

const MAX_FILE_BYTES = 1_000_000;
/** Skills stored with this scope are available to every bot and to unnamed runs. */
const SHARED = "";

export interface SkillFile {
  path: string;
  content: string;
}

export function parseSkillMetadata(name: string, document: string): SkillSummary {
  const header = /^(?:﻿)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
  if (!header) throw new Error("SKILL.md needs YAML frontmatter with name and description.");
  const metadata = metadataSchema.parse(parse(header[1]!));
  if (metadata.name !== name) throw new Error("Skill name must match its folder name.");
  return metadata;
}

/** Turns a path relative to the skill folder into its stored form, rejecting paths that leave the folder. */
function normalizePath(file: string): string {
  const path = posix.normalize(file.replaceAll("\\", "/"));
  if (path === "." || path === ".." || path.startsWith("../") || path.startsWith("/")) {
    throw new Error("Skill file path must stay inside its skill folder.");
  }
  return path;
}

/**
 * The skills a run can see, stored in the database. A named bot sees shared
 * skills plus its own; its own skill wins when both use the same name.
 */
export class SkillStore {
  private readonly scopes: string[];
  private readonly database: Database;

  constructor(bot?: Bot, database: Database = getDatabase()) {
    this.scopes = bot ? [bot.id, SHARED] : [SHARED];
    this.database = database;
  }

  async catalog(): Promise<{ skills: SkillSummary[]; errors: string[] }> {
    await ensureSchema(this.database);
    const rows = await this.database.query<{ scope: string; skill: string; content: string }>(
      `SELECT scope, skill, content FROM skill_files WHERE path = 'SKILL.md' AND scope IN (${this.scopes.map(() => "?").join(", ")})`,
      this.scopes,
    );
    const chosen = new Map<string, string>();
    for (const scope of [...this.scopes].reverse()) {
      for (const row of rows) if (row.scope === scope) chosen.set(row.skill, row.content);
    }
    const skills: SkillSummary[] = [];
    const errors: string[] = [];
    for (const [name, content] of [...chosen].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        skills.push(parseSkillMetadata(name, content));
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      }
    }
    return { skills, errors };
  }

  async metadata(name: string): Promise<SkillSummary> {
    return parseSkillMetadata(name, await this.read(name, "SKILL.md"));
  }

  async read(name: string, file: string): Promise<string> {
    skillName.parse(name);
    const path = normalizePath(file);
    const scope = await this.scopeOf(name);
    const [row] = await this.database.query<{ content: string }>(
      "SELECT content FROM skill_files WHERE scope = ? AND skill = ? AND path = ?", [scope, name, path],
    );
    if (!row) throw new Error(`Skill "${name}" has no file "${path}".`);
    return row.content;
  }

  /** Finds which scope provides the skill, so its supporting files come from the same place as its SKILL.md. */
  private async scopeOf(name: string): Promise<string> {
    await ensureSchema(this.database);
    const rows = await this.database.query<{ scope: string }>(
      `SELECT scope FROM skill_files WHERE skill = ? AND path = 'SKILL.md' AND scope IN (${this.scopes.map(() => "?").join(", ")})`,
      [name, ...this.scopes],
    );
    const scope = this.scopes.find((item) => rows.some((row) => row.scope === item));
    if (scope === undefined) throw new Error(`No skill named "${name}".`);
    return scope;
  }
}

/**
 * Saves a skill, replacing any earlier version with the same name in the same
 * scope. Pass a bot to make the skill visible to that bot only.
 */
export async function saveSkill(name: string, files: SkillFile[], options: { bot?: Bot; database?: Database } = {}): Promise<SkillSummary> {
  skillName.parse(name);
  const normalized = files.map((file) => ({ path: normalizePath(file.path), content: file.content }));
  for (const file of normalized) {
    if (Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw new Error(`${file.path} is larger than 1 MB.`);
  }
  const skill = normalized.find((file) => file.path === "SKILL.md");
  if (!skill) throw new Error("A skill needs a SKILL.md file.");
  const metadata = parseSkillMetadata(name, skill.content);
  const database = options.database ?? getDatabase();
  await ensureSchema(database);
  const scope = options.bot?.id ?? SHARED;
  // Write the new files under a fresh revision, then drop files left from the previous one.
  const revision = randomUUID();
  for (const file of normalized) {
    await database.run(
      `INSERT INTO skill_files (scope, skill, path, content, revision) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, skill, path) DO UPDATE SET content = excluded.content, revision = excluded.revision`,
      [scope, name, file.path, file.content, revision],
    );
  }
  await database.run("DELETE FROM skill_files WHERE scope = ? AND skill = ? AND revision <> ?", [scope, name, revision]);
  return metadata;
}

export async function removeSkill(name: string, options: { bot?: Bot; database?: Database } = {}): Promise<void> {
  skillName.parse(name);
  const database = options.database ?? getDatabase();
  await ensureSchema(database);
  const { changes } = await database.run("DELETE FROM skill_files WHERE scope = ? AND skill = ?", [options.bot?.id ?? SHARED, name]);
  if (!changes) throw new Error(`No skill named "${name}"${options.bot ? ` for ${options.bot.name}` : " shared by all bots"}.`);
}

export async function skillExists(name: string, options: { bot?: Bot; database?: Database } = {}): Promise<boolean> {
  const database = options.database ?? getDatabase();
  await ensureSchema(database);
  const rows = await database.query(
    "SELECT 1 AS found FROM skill_files WHERE scope = ? AND skill = ? AND path = 'SKILL.md'", [options.bot?.id ?? SHARED, name],
  );
  return rows.length > 0;
}

/** Reads every text file in a local skill folder. Symbolic links are skipped so nothing outside the folder is uploaded. */
export async function readSkillFolder(folder: string): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(folder, path).split(sep).join("/");
      if ((await lstat(path)).size > MAX_FILE_BYTES) throw new Error(`${relativePath} is larger than 1 MB.`);
      const bytes = await readFile(path);
      if (bytes.includes(0)) throw new Error(`${relativePath} is not a text file.`);
      files.push({ path: relativePath, content: bytes.toString("utf8") });
    }
  }
  await walk(folder);
  return files;
}
