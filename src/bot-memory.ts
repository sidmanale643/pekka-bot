import type { Bot } from "./bots.ts";
import { ensureSchema, getDatabase, type Database } from "./database/database.ts";

export const memoryFiles = ["PREFERENCES.md", "KNOWLEDGE.md"] as const;
export type MemoryFile = typeof memoryFiles[number];

const defaults: Record<MemoryFile, string> = { "PREFERENCES.md": "# Preferences\n", "KNOWLEDGE.md": "# Knowledge\n" };

/** A bot's Markdown memory, stored in the database under the bot's ID. */
export class BotMemory {
  private readonly botId: string;
  private readonly database: Database;

  constructor(bot: Bot, database: Database = getDatabase()) {
    this.botId = bot.id;
    this.database = database;
  }

  async read(file: MemoryFile): Promise<string> {
    if (!memoryFiles.includes(file)) throw new Error("Unknown memory file.");
    await ensureSchema(this.database);
    const [row] = await this.database.query<{ content: string }>(
      "SELECT content FROM bot_memory WHERE bot_id = ? AND file = ?", [this.botId, file],
    );
    return row?.content ?? defaults[file];
  }

  async write(file: MemoryFile, content: string): Promise<void> {
    if (!memoryFiles.includes(file)) throw new Error("Unknown memory file.");
    await ensureSchema(this.database);
    await this.database.run(
      `INSERT INTO bot_memory (bot_id, file, content, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(bot_id, file) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      [this.botId, file, content, new Date().toISOString()],
    );
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
