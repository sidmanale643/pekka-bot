import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { botKey } from "./bot-memory.ts";
import type { Bot } from "./bots.ts";

export const skillName = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const metadataSchema = z.object({ name: skillName, description: z.string().trim().min(1).max(1024) });
export type SkillSummary = z.infer<typeof metadataSchema>;

export class SkillStore {
  readonly directory: string;

  constructor(bot?: Bot, projectDirectory = process.cwd()) {
    this.directory = bot
      ? join(projectDirectory, ".pekka", "bots", botKey(bot, projectDirectory), "skills")
      : join(projectDirectory, ".pekka", "skills");
  }

  async catalog(): Promise<{ skills: SkillSummary[]; errors: string[] }> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { skills: [], errors: [] };
      throw error;
    }
    const skills: SkillSummary[] = [];
    const errors: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      try {
        skills.push(await this.metadata(entry.name));
      } catch (error) {
        errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      }
    }
    return { skills, errors };
  }

  async metadata(name: string): Promise<SkillSummary> {
    const document = await this.read(name, "SKILL.md");
    const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
    if (!header) throw new Error("SKILL.md needs YAML frontmatter with name and description.");
    const metadata = metadataSchema.parse(parse(header[1]!));
    if (metadata.name !== name) throw new Error("Skill name must match its folder name.");
    return metadata;
  }

  async read(name: string, file: string): Promise<string> {
    skillName.parse(name);
    const root = await realpath(this.directory);
    const folder = await realpath(join(root, name));
    assertWithin(root, folder);
    const path = await realpath(resolve(folder, file));
    assertWithin(folder, path);
    const info = await stat(path);
    if (!info.isFile() || info.size > 1_000_000) throw new Error("Skill files must be text files under 1 MB.");
    const content = await readFile(path, "utf8");
    if (content.includes("\0")) throw new Error("Skill files must be text.");
    return content;
  }
}

function assertWithin(root: string, path: string): void {
  const location = relative(root, path);
  if (location === ".." || location.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(location)) {
    throw new Error("Skill file path must stay inside its skill folder.");
  }
}
