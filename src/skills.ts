import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
/**
 * Skills that ship with Pekka. vercel.json bundles this folder, and .vercelignore
 * drops any path segment named `skills` or `references`, so don't use either inside it.
 */
const BASE_SKILLS = fileURLToPath(new URL("./base-skills/", import.meta.url));

/** Where a skill comes from: the bot's own, shared by every bot, or shipped with Pekka. */
export type SkillSource = "bot" | "shared" | "base";
export type CatalogSkill = SkillSummary & { source: SkillSource };

export interface SkillFile {
  path: string;
  content: string;
}

let baseSkills: Promise<Map<string, SkillFile[]>> | undefined;

/** Reads the skills that ship with Pekka once per process. */
function loadBaseSkills(): Promise<Map<string, SkillFile[]>> {
  return baseSkills ??= (async () => {
    const skills = new Map<string, SkillFile[]>();
    for (const entry of await readdir(BASE_SKILLS, { withFileTypes: true })) {
      if (entry.isDirectory()) skills.set(entry.name, await readSkillFolder(join(BASE_SKILLS, entry.name)));
    }
    return skills;
  })();
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
 * The skills a run can see. A named bot sees its own skills, then shared ones,
 * then the skills that ship with Pekka; the first to use a name wins. Unnamed
 * runs see only shared skills, because the bundled skill-creator needs a bot
 * to save skills to.
 */
export class SkillStore {
  private readonly scopes: string[];
  private readonly database: Database;
  private readonly base: boolean;

  constructor(bot?: Bot, database: Database = getDatabase()) {
    this.scopes = bot ? [bot.id, SHARED] : [SHARED];
    this.database = database;
    this.base = Boolean(bot);
  }

  async catalog(): Promise<{ skills: CatalogSkill[]; errors: string[] }> {
    await ensureSchema(this.database);
    const rows = await this.database.query<{ scope: string; skill: string; content: string }>(
      `SELECT scope, skill, content FROM skill_files WHERE path = 'SKILL.md' AND scope IN (${this.scopes.map(() => "?").join(", ")})`,
      this.scopes,
    );
    const chosen = new Map<string, { content: string; source: SkillSource }>();
    if (this.base) {
      for (const [name, files] of await loadBaseSkills()) {
        chosen.set(name, { content: files.find((file) => file.path === "SKILL.md")?.content ?? "", source: "base" });
      }
    }
    for (const scope of [...this.scopes].reverse()) {
      const source = scope === SHARED ? "shared" : "bot";
      for (const row of rows) if (row.scope === scope) chosen.set(row.skill, { content: row.content, source });
    }
    const skills: CatalogSkill[] = [];
    const errors: string[] = [];
    for (const [name, { content, source }] of [...chosen].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        skills.push({ ...parseSkillMetadata(name, content), source });
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
    const source = await this.sourceOf(name);
    const content = "files" in source
      ? source.files.find((item) => item.path === path)?.content
      : (await this.database.query<{ content: string }>(
        "SELECT content FROM skill_files WHERE scope = ? AND skill = ? AND path = ?", [source.scope, name, path],
      ))[0]?.content;
    if (content === undefined) throw new Error(`Skill "${name}" has no file "${path}".`);
    return content;
  }

  /** Finds what provides the skill, so its supporting files come from the same place as its SKILL.md. */
  private async sourceOf(name: string): Promise<{ scope: string } | { files: SkillFile[] }> {
    await ensureSchema(this.database);
    const rows = await this.database.query<{ scope: string }>(
      `SELECT scope FROM skill_files WHERE skill = ? AND path = 'SKILL.md' AND scope IN (${this.scopes.map(() => "?").join(", ")})`,
      [name, ...this.scopes],
    );
    const scope = this.scopes.find((item) => rows.some((row) => row.scope === item));
    if (scope !== undefined) return { scope };
    const files = this.base ? (await loadBaseSkills()).get(name) : undefined;
    if (!files) throw new Error(`No skill named "${name}".`);
    return { files };
  }
}

/**
 * Saves a skill, replacing any earlier version with the same name in the same
 * scope. Pass a bot to make the skill visible to that bot only.
 */
export async function saveSkill(name: string, files: SkillFile[], options: { bot?: Bot; database?: Database } = {}): Promise<SkillSummary> {
  const normalized = checkFiles(name, files);
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

/**
 * Adds or replaces some of a skill's files and keeps the rest. A new skill
 * needs its SKILL.md. Pass a bot to change that bot's own skill only.
 */
export async function updateSkill(name: string, files: SkillFile[], options: { bot?: Bot; database?: Database } = {}): Promise<SkillSummary> {
  const normalized = checkFiles(name, files);
  const database = options.database ?? getDatabase();
  await ensureSchema(database);
  const scope = options.bot?.id ?? SHARED;
  const [saved] = await database.query<{ content: string }>(
    "SELECT content FROM skill_files WHERE scope = ? AND skill = ? AND path = 'SKILL.md'", [scope, name],
  );
  const skill = normalized.findLast((file) => file.path === "SKILL.md") ?? saved;
  if (!skill) throw new Error(`A new skill needs a SKILL.md file, and "${name}" doesn't exist${options.bot ? ` for ${options.bot.name}` : " as a shared skill"} yet.`);
  const metadata = parseSkillMetadata(name, skill.content);
  const revision = randomUUID();
  for (const file of normalized) {
    await database.run(
      `INSERT INTO skill_files (scope, skill, path, content, revision) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, skill, path) DO UPDATE SET content = excluded.content, revision = excluded.revision`,
      [scope, name, file.path, file.content, revision],
    );
  }
  return metadata;
}

/** Checks a skill's name and file sizes, and puts its file paths in stored form. */
function checkFiles(name: string, files: SkillFile[]): SkillFile[] {
  skillName.parse(name);
  const normalized = files.map((file) => ({ path: normalizePath(file.path), content: file.content }));
  for (const file of normalized) {
    if (Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw new Error(`${file.path} is larger than 1 MB.`);
  }
  return normalized;
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
