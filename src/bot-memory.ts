import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bot } from "./bots.ts";

export const memoryFiles = ["PREFERENCES.md", "KNOWLEDGE.md"] as const;
export type MemoryFile = typeof memoryFiles[number];

export function botKey(bot: Bot, projectDirectory = process.cwd()): string {
  return createHash("sha256").update(`${realpathSync(projectDirectory)}\0${bot.name.trim().toLowerCase()}`).digest("hex").slice(0, 24);
}

export class BotMemory {
  readonly directory: string;

  constructor(bot: Bot, projectDirectory = process.cwd()) {
    this.directory = join(projectDirectory, ".pekka", "bots", botKey(bot, projectDirectory), "memory");
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const file of memoryFiles) {
      try {
        await writeFile(join(this.directory, file), `# ${file === "PREFERENCES.md" ? "Preferences" : "Knowledge"}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  async read(file: MemoryFile): Promise<string> {
    if (!memoryFiles.includes(file)) throw new Error("Unknown memory file.");
    return readFile(join(this.directory, file), "utf8");
  }

  async write(file: MemoryFile, content: string): Promise<void> {
    if (!memoryFiles.includes(file)) throw new Error("Unknown memory file.");
    const temporary = join(this.directory, `.${file}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, "utf8");
      await rename(temporary, join(this.directory, file));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async snapshot(): Promise<string> {
    const sections = [];
    for (const file of memoryFiles) {
      const content = await this.read(file);
      sections.push(`${file}:\n${content.slice(0, 8000)}${content.length > 8000 ? "\n[Preview truncated; use read_memory for more.]" : ""}`);
    }
    return sections.join("\n\n");
  }
}
