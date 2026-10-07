import { ensureSchema, getDatabase, type Database } from "./database/database.ts";

/** How many of a bot's latest messages a chat loads. */
export const HISTORY_LIMIT = 500;
/** D1 binds at most 100 parameters per statement, and each row takes 6. */
const ROWS_PER_INSERT = 16;

/** A chat message, with its tool steps, cards and run status. The server writes them as a bot's runs go. */
export interface ChatMessage {
  id: string;
  time: number;
  role: "user" | "assistant" | "error";
  text: string;
  [field: string]: unknown;
}

/** A bot's latest messages, oldest first. Messages sent in the same millisecond keep the order they were saved in. */
export async function listMessages(userId: string, botId: string, database: Database = getDatabase()): Promise<ChatMessage[]> {
  await ensureSchema(database);
  const rows = await database.query<{ data: string }>(
    `SELECT data FROM (
       SELECT data, time, rowid FROM chat_messages WHERE user_id = ? AND bot_id = ? ORDER BY time DESC, rowid DESC LIMIT ?
     ) ORDER BY time, rowid`,
    [userId, botId, HISTORY_LIMIT],
  );
  return rows.map((row) => JSON.parse(row.data) as ChatMessage);
}

/** Adds messages, or replaces the ones already saved under the same IDs. A replaced message keeps its place. */
export async function saveMessages(userId: string, botId: string, messages: ChatMessage[], database: Database = getDatabase()): Promise<void> {
  await ensureSchema(database);
  const now = new Date().toISOString();
  for (let start = 0; start < messages.length; start += ROWS_PER_INSERT) {
    const rows = messages.slice(start, start + ROWS_PER_INSERT);
    await database.run(
      `INSERT INTO chat_messages (user_id, bot_id, id, time, data, updated_at) VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
       ON CONFLICT (user_id, bot_id, id) DO UPDATE SET time = excluded.time, data = excluded.data, updated_at = excluded.updated_at`,
      rows.flatMap((message) => [userId, botId, message.id, message.time, JSON.stringify(message), now]),
    );
  }
}

export async function deleteMessages(userId: string, botId: string, database: Database = getDatabase()): Promise<void> {
  await ensureSchema(database);
  await database.run("DELETE FROM chat_messages WHERE user_id = ? AND bot_id = ?", [userId, botId]);
}
