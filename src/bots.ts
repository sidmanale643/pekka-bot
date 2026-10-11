import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AvatarSchema, newAvatar, type Avatar } from "./avatars.ts";
import { deleteMessages } from "./chat-history.ts";
import { ensureSchema, getDatabase, type Database } from "./database/database.ts";

const ProfileSchema = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  job: z.string().trim(),
  avatar: AvatarSchema.optional(),
});

/** What a person provides when creating a bot. */
export type BotProfile = z.infer<typeof ProfileSchema>;

const BotSchema = ProfileSchema.extend({
  id: z.string().regex(/^[0-9a-f]{24}$/),
  /** Set only on the user's chief of staff, the primary bot that manages their other bots. */
  primary: z.literal(true).optional(),
});

/**
 * A saved bot. The ID is fixed at creation and names the bot's sandbox, memory
 * and skills, so the bot is the same on every machine that uses the database.
 */
export type Bot = z.infer<typeof BotSchema>;

export class DuplicateBotError extends Error {}

/** What a new user's chief of staff starts with. It learns the rest through conversation. */
export const CHIEF_OF_STAFF: BotProfile = {
  name: "Chief of Staff",
  role: "Your primary bot. It runs your team of bots: it takes requests, hands work to the right bot, creates new bots when you need them and keeps track of what is scheduled.",
  job: "",
};

const COLUMNS = "id, name, role, job, is_primary, avatar";

function toBot({ is_primary, avatar, ...row }: Record<string, unknown>): Bot {
  // An avatar that no longer parses falls back to base Pekka rather than hiding the bot.
  const look = avatar ? AvatarSchema.safeParse(JSON.parse(String(avatar))) : undefined;
  const value = { ...row, ...(look?.success ? { avatar: look.data } : {}) };
  return BotSchema.parse(Number(is_primary) === 1 ? { ...value, primary: true } : value);
}

export async function updateBot(userId: string, id: string, input: BotProfile, database: Database = getDatabase()): Promise<Bot> {
  const bot = BotSchema.parse({ ...ProfileSchema.parse(input), id });
  await ensureSchema(database);
  const { changes } = await database.run(
    "UPDATE bot_profiles SET name_key = ?, name = ?, role = ?, job = ?, avatar = COALESCE(NULLIF(?, ''), avatar) WHERE id = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM bot_profiles WHERE user_id = ? AND name_key = ? AND id <> ?)",
    [nameKey(bot.name), bot.name, bot.role, bot.job, bot.avatar ? JSON.stringify(bot.avatar) : "", id, userId, userId, nameKey(bot.name), id],
  );
  const updated = changes ? await findBotById(userId, id, database) : undefined;
  if (!updated) throw new DuplicateBotError(`A bot named "${bot.name}" already exists or the bot was removed.`);
  return updated;
}

/** The chief of staff is never deleted. */
export async function deleteBot(userId: string, id: string, database: Database = getDatabase()): Promise<void> {
  await ensureSchema(database);
  const { changes } = await database.run("DELETE FROM bot_profiles WHERE id = ? AND user_id = ? AND is_primary = 0", [id, userId]);
  if (changes) await deleteMessages(userId, id, database);
}

/** Bot names are unique regardless of case. */
const nameKey = (name: string) => name.trim().toLowerCase();

/** The bots `userId` owns, chief of staff first. Each user only ever sees their own. */
export async function listBots(userId: string, database: Database = getDatabase()): Promise<Bot[]> {
  await ensureSchema(database);
  const rows = await database.query(`SELECT ${COLUMNS} FROM bot_profiles WHERE user_id = ? ORDER BY is_primary DESC, rowid`, [userId]);
  const bots = rows.map(toBot);
  // Bots made before each new bot got its own look get one now, so no two share a face. The chief stays base Pekka.
  const bare = bots.filter((bot, i) => rows[i]!.avatar == null && !bot.primary);
  const taken = bots.flatMap((bot) => (bot.avatar ? [bot.avatar] : bot.primary ? [{ kind: "pekka" } as const] : []));
  for (const bot of bare) {
    bot.avatar = newAvatar(taken);
    taken.push(bot.avatar);
    await database.run("UPDATE bot_profiles SET avatar = ? WHERE id = ? AND user_id = ? AND avatar IS NULL", [JSON.stringify(bot.avatar), bot.id, userId]);
  }
  return bots;
}

export async function findBot(userId: string, name: string, database: Database = getDatabase()): Promise<Bot | undefined> {
  await ensureSchema(database);
  const [row] = await database.query(`SELECT ${COLUMNS} FROM bot_profiles WHERE user_id = ? AND name_key = ?`, [userId, nameKey(name)]);
  return row ? toBot(row) : undefined;
}

export async function findBotById(userId: string, id: string, database: Database = getDatabase()): Promise<Bot | undefined> {
  await ensureSchema(database);
  const [row] = await database.query(`SELECT ${COLUMNS} FROM bot_profiles WHERE user_id = ? AND id = ?`, [userId, id]);
  return row ? toBot(row) : undefined;
}

export async function getBot(userId: string, name: string, database?: Database): Promise<Bot> {
  const bot = await findBot(userId, name, database);
  if (!bot) throw new Error(`No bot named "${name}". Run "pekka bot list" to see available bots.`);
  return bot;
}

/** The looks a user's bots already wear; a bot without one wears base Pekka. */
async function takenLooks(userId: string, database: Database): Promise<Avatar[]> {
  const rows = await database.query("SELECT avatar FROM bot_profiles WHERE user_id = ?", [userId]);
  return rows.map(({ avatar }) => (avatar ? AvatarSchema.safeParse(JSON.parse(String(avatar))).data : undefined) ?? { kind: "pekka" as const });
}

/** A look none of the user's bots wear yet, for a new bot. */
export async function suggestAvatar(userId: string, database: Database = getDatabase()): Promise<Avatar> {
  await ensureSchema(database);
  return newAvatar(await takenLooks(userId, database));
}

/** `id` is only passed when importing a bot whose sandbox already exists under that ID. Without a chosen look, a bot gets its own. */
export async function createBot(userId: string, input: BotProfile, database: Database = getDatabase(), id = randomBytes(12).toString("hex")): Promise<Bot> {
  const profile = ProfileSchema.parse(input);
  await ensureSchema(database);
  const bot = BotSchema.parse({ ...profile, avatar: profile.avatar ?? await suggestAvatar(userId, database), id });
  // The unique (user, name key) pair makes the duplicate check atomic across processes and machines.
  const { changes } = await database.run(
    "INSERT INTO bot_profiles (id, user_id, name_key, name, role, job, created_at, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, '')) ON CONFLICT DO NOTHING",
    [bot.id, userId, nameKey(bot.name), bot.name, bot.role, bot.job, new Date().toISOString(), bot.avatar ? JSON.stringify(bot.avatar) : ""],
  );
  if (!changes) throw new DuplicateBotError(`A bot named "${bot.name}" already exists.`);
  return bot;
}

/**
 * Every user has one chief of staff. It is created the first time their bots
 * are listed; a bot they already named "Chief of Staff" is promoted instead.
 * Renaming it later keeps it primary.
 */
export async function ensureChiefOfStaff(userId: string, database: Database = getDatabase()): Promise<Bot> {
  await ensureSchema(database);
  const find = async () => {
    const [row] = await database.query(`SELECT ${COLUMNS} FROM bot_profiles WHERE user_id = ? AND is_primary = 1`, [userId]);
    return row ? toBot(row) : undefined;
  };
  const existing = await find();
  if (existing) return existing;
  // The unique index on primary bots turns a concurrent second creation into a no-op.
  const { name, role, job } = CHIEF_OF_STAFF;
  await database.run(
    "INSERT INTO bot_profiles (id, user_id, name_key, name, role, job, created_at, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING",
    [randomBytes(12).toString("hex"), userId, nameKey(name), name, role, job, new Date().toISOString()],
  );
  await database.run(
    "UPDATE bot_profiles SET is_primary = 1 WHERE user_id = ? AND name_key = ? AND NOT EXISTS (SELECT 1 FROM bot_profiles WHERE user_id = ? AND is_primary = 1)",
    [userId, nameKey(name), userId],
  );
  const chief = await find();
  if (!chief) throw new Error("Could not set up the chief of staff.");
  return chief;
}
