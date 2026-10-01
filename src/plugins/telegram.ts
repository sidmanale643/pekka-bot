import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ensureSchema, getDatabase, type Database } from "../database/database.ts";

type Connection = { credentials: string; workspace_name: string; enabled: number };
const Linked = z.object({ chat_id: z.number().int() });
const Reply = z.object({ ok: z.boolean(), result: z.unknown().optional(), description: z.string().optional(), error_code: z.number().optional() });
const Update = z.object({
  update_id: z.number().int(),
  message: z.object({
    date: z.number(),
    text: z.string().optional(),
    chat: z.object({ id: z.number().int(), type: z.string(), username: z.string().optional(), first_name: z.string().optional() }),
  }).optional(),
});
const LINK_TTL = 600_000;

export class TelegramError extends Error {}

export class TelegramService {
  private readonly databaseFor: () => Database;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;
  private pending: Promise<unknown> = Promise.resolve();
  /** Each user's linking attempt in progress. One bot serves every user, so each links their own chat. */
  private readonly links = new Map<string, { code: string; url: string; expires: number; since: number }>();
  /** Users whose chat was linked while someone else was checking, until they check themselves. */
  private readonly linkedByOthers = new Set<string>();
  private offset = 0;

  constructor(options: { database?: () => Database; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
    this.databaseFor = options.database ?? getDatabase;
    this.env = options.env ?? process.env;
    this.fetcher = options.fetch ?? fetch;
  }

  private token(): string {
    const token = this.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token || !/^\d+:[\w-]{30,}$/.test(token)) throw new TelegramError("Telegram needs TELEGRAM_BOT_TOKEN from @BotFather. See .env.example.");
    return token;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  private async database() {
    const database = this.databaseFor();
    await ensureSchema(database);
    return database;
  }

  private async connection(database: Database, userId: string): Promise<Connection | undefined> {
    const [row] = await database.query<Connection>("SELECT credentials, workspace_name, enabled FROM plugin_accounts WHERE user_id = ? AND plugin = ?", [userId, "telegram"]);
    return row;
  }

  // The bot token is part of the URL path, so failures never echo the URL.
  private async call(method: string, data: unknown): Promise<unknown> {
    const token = this.token();
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
    } catch { throw new TelegramError("Could not reach Telegram. A message may have been sent; check Telegram before retrying."); }
    const reply = Reply.safeParse(await response.json().catch(() => null));
    if (!reply.success) throw new TelegramError(`Telegram returned an unreadable response (HTTP ${response.status}).`);
    if (!reply.data.ok) {
      throw new TelegramError(`Telegram request failed (${reply.data.error_code ?? response.status}: ${reply.data.description?.slice(0, 300) ?? "unknown error"}).`);
    }
    return reply.data.result;
  }

  async status(userId: string) {
    const base = { id: "telegram", name: "Telegram", configured: false, connected: false, enabled: false, workspaceName: "", linking: false };
    try { this.token(); } catch { return base; }
    const row = await this.connection(await this.database(), userId);
    const link = this.links.get(userId);
    const linking = !!link && link.expires > Date.now();
    return { ...base, configured: true, connected: !!row, enabled: Number(row?.enabled) === 1, workspaceName: row?.workspace_name ?? "", linking, linkUrl: linking ? link.url : undefined };
  }

  /** Starts linking: the user opens the returned t.me link and presses Start, which sends `/start <code>` to the bot. */
  async startLink(userId: string): Promise<{ url: string }> {
    return this.serial(async () => {
      const me = z.object({ username: z.string().regex(/^\w{5,32}$/) }).safeParse(await this.call("getMe", {}));
      if (!me.success) throw new TelegramError("Telegram returned an invalid bot profile. Check TELEGRAM_BOT_TOKEN.");
      const code = randomBytes(16).toString("hex");
      const url = `https://t.me/${me.data.username}?start=${code}`;
      this.links.set(userId, { code, url, expires: Date.now() + LINK_TTL, since: Math.floor(Date.now() / 1000) - 5 });
      this.linkedByOthers.delete(userId);
      return { url };
    });
  }

  /**
   * Reads pending bot updates and links the private chat that sent `userId`'s
   * current code. Updates are consumed once for everyone, so codes from other
   * users' links in progress are matched in the same pass.
   */
  checkLink(userId: string): Promise<boolean> {
    return this.serial(async () => {
      if (this.linkedByOthers.delete(userId)) return true;
      const own = this.links.get(userId);
      if (!own || own.expires < Date.now()) { this.links.delete(userId); throw new TelegramError("The Telegram link expired. Start linking again."); }
      let linked = false;
      for (let page = 0; page < 10 && !linked; page++) {
        const updates = z.array(Update).safeParse(await this.call("getUpdates", { offset: this.offset, timeout: 0, limit: 100, allowed_updates: ["message"] }));
        if (!updates.success) throw new TelegramError("Telegram returned invalid updates.");
        if (!updates.data.length) return false;
        this.offset = Math.max(...updates.data.map((update) => update.update_id)) + 1;
        for (const [owner, link] of [...this.links]) {
          if (link.expires < Date.now()) { this.links.delete(owner); continue; }
          const match = updates.data.find(({ message }) => message?.chat.type === "private" && message.text === `/start ${link.code}` && message.date >= link.since);
          if (!match?.message) continue;
          const { chat } = match.message;
          const database = await this.database();
          const name = chat.username ? `@${chat.username}` : chat.first_name ?? "your Telegram chat";
          await database.run("INSERT INTO plugin_accounts (user_id, plugin, credentials, workspace_name, enabled) VALUES (?, ?, ?, ?, 0) ON CONFLICT(user_id, plugin) DO UPDATE SET credentials = excluded.credentials, workspace_name = excluded.workspace_name, enabled = 0", [owner, "telegram", JSON.stringify({ chat_id: chat.id }), name]);
          if (this.links.get(owner) === link) this.links.delete(owner);
          if (owner === userId) linked = true;
          else this.linkedByOthers.add(owner);
          await this.call("sendMessage", { chat_id: chat.id, text: "Linked to Pekka. Turn on access in Plugins to let your bots message you here." }).catch(() => {});
        }
      }
      return linked;
    });
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    const database = await this.database();
    if (enabled) {
      this.token();
      if (!await this.connection(database, userId)) throw new TelegramError("Link Telegram before allowing access.");
    }
    await database.run("UPDATE plugin_accounts SET enabled = ? WHERE user_id = ? AND plugin = ?", [enabled ? 1 : 0, userId, "telegram"]);
  }

  cancelLink(userId: string): Promise<void> {
    return this.serial(async () => {
      this.links.delete(userId);
      this.linkedByOthers.delete(userId);
    });
  }

  disconnect(userId: string): Promise<void> {
    return this.serial(async () => {
      this.links.delete(userId);
      this.linkedByOthers.delete(userId);
      const database = await this.database();
      await database.run("DELETE FROM plugin_accounts WHERE user_id = ? AND plugin = ?", [userId, "telegram"]);
    });
  }

  /** Messages `userId`'s linked chat. */
  async send(userId: string, text: string): Promise<{ message_id: number }> {
    this.token();
    const row = await this.connection(await this.database(), userId);
    if (!row || Number(row.enabled) !== 1) throw new TelegramError("Telegram access is off. Link Telegram and allow Pekka access in Plugins.");
    const { chat_id } = Linked.parse(JSON.parse(row.credentials));
    const sent = z.object({ message_id: z.number().int() }).safeParse(await this.call("sendMessage", { chat_id, text, link_preview_options: { is_disabled: true } }));
    if (!sent.success) throw new TelegramError("Telegram accepted the message but returned an unexpected receipt. Check Telegram before retrying.");
    return { message_id: sent.data.message_id };
  }
}

let defaultService: TelegramService | undefined;
export function getTelegramService(): TelegramService {
  return defaultService ??= new TelegramService();
}
