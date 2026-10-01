import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ensureSchema, getDatabase, type Database } from "./database/database.ts";

const ProfileSchema = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  job: z.string().trim().min(1),
});

/** What a person provides when creating a bot. */
export type BotProfile = z.infer<typeof ProfileSchema>;

const BotSchema = ProfileSchema.extend({ id: z.string().regex(/^[0-9a-f]{24}$/) });

/**
 * A saved bot. The ID is fixed at creation and names the bot's sandbox, memory
 * and skills, so the bot is the same on every machine that uses the database.
 */
export type Bot = z.infer<typeof BotSchema>;

export class DuplicateBotError extends Error {}

export async function updateBot(userId: string, id: string, input: BotProfile, database: Database = getDatabase()): Promise<Bot> {
  const bot = BotSchema.parse({ ...ProfileSchema.parse(input), id });
  await ensureSchema(database);
  const { changes } = await database.run(
    "UPDATE bot_profiles SET name_key = ?, name = ?, role = ?, job = ? WHERE id = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM bot_profiles WHERE user_id = ? AND name_key = ? AND id <> ?)",
    [nameKey(bot.name), bot.name, bot.role, bot.job, id, userId, userId, nameKey(bot.name), id],
  );
  if (!changes) throw new DuplicateBotError(`A bot named "${bot.name}" already exists or the bot was removed.`);
  return bot;
}

export async function deleteBot(userId: string, id: string, database: Database = getDatabase()): Promise<void> {
  await ensureSchema(database);
  await database.run("DELETE FROM bot_profiles WHERE id = ? AND user_id = ?", [id, userId]);
}

/** Bot names are unique regardless of case. */
const nameKey = (name: string) => name.trim().toLowerCase();

/** The bots `userId` owns. Each user only ever sees their own. */
export async function listBots(userId: string, database: Database = getDatabase()): Promise<Bot[]> {
  await ensureSchema(database);
  return z.array(BotSchema).parse(await database.query("SELECT id, name, role, job FROM bot_profiles WHERE user_id = ? ORDER BY rowid", [userId]));
}

export async function findBot(userId: string, name: string, database: Database = getDatabase()): Promise<Bot | undefined> {
  await ensureSchema(database);
  const [row] = await database.query("SELECT id, name, role, job FROM bot_profiles WHERE user_id = ? AND name_key = ?", [userId, nameKey(name)]);
  return row ? BotSchema.parse(row) : undefined;
}

export async function findBotById(userId: string, id: string, database: Database = getDatabase()): Promise<Bot | undefined> {
  await ensureSchema(database);
  const [row] = await database.query("SELECT id, name, role, job FROM bot_profiles WHERE user_id = ? AND id = ?", [userId, id]);
  return row ? BotSchema.parse(row) : undefined;
}

export async function getBot(userId: string, name: string, database?: Database): Promise<Bot> {
  const bot = await findBot(userId, name, database);
  if (!bot) throw new Error(`No bot named "${name}". Run "pekka bot list" to see available bots.`);
  return bot;
}

/** `id` is only passed when importing a bot whose sandbox already exists under that ID. */
export async function createBot(userId: string, input: BotProfile, database: Database = getDatabase(), id = randomBytes(12).toString("hex")): Promise<Bot> {
  const bot = BotSchema.parse({ ...ProfileSchema.parse(input), id });
  await ensureSchema(database);
  // The unique (user, name key) pair makes the duplicate check atomic across processes and machines.
  const { changes } = await database.run(
    "INSERT INTO bot_profiles (id, user_id, name_key, name, role, job, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    [bot.id, userId, nameKey(bot.name), bot.name, bot.role, bot.job, new Date().toISOString()],
  );
  if (!changes) throw new DuplicateBotError(`A bot named "${bot.name}" already exists.`);
  return bot;
}
