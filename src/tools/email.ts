import { z } from "zod";
import type { Bot } from "../bots.ts";
import { ensureSchema, getDatabase, type Database } from "../database/database.ts";
import { defineTool } from "./tool.ts";

const InboxSchema = z.object({ inbox_id: z.string().min(1), email: z.email() });
const SentSchema = z.object({ message_id: z.string().min(1), thread_id: z.string().min(1) });

export function createEmailTools(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
  databaseFor: () => Database = getDatabase,
) {
  function apiKey() {
    const key = env.AGENTMAIL_API_KEY?.trim();
    if (!key) throw new Error("Email needs AGENTMAIL_API_KEY. Set it in .env and restart Pekka. See .env.example.");
    return key;
  }

  async function post(path: string, body: unknown, sending = false): Promise<unknown> {
    const key = apiKey();
    let response: Response;
    try {
      response = await request(`https://api.agentmail.to/v0${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(sending
        ? "Email submission outcome unknown after a network error. Do not retry automatically; check the AgentMail console first to avoid duplicate mail."
        : "Could not reach AgentMail to create the mailbox. Try again later.");
    }
    if (!response.ok) {
      const detail = sending && response.status >= 500
        ? " Submission outcome unknown. Do not retry automatically; check the AgentMail console first."
        : " Check the AgentMail console for account verification, permissions, and quota.";
      throw new Error(`AgentMail HTTP ${response.status}.${detail}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error(sending
        ? "AgentMail accepted the request but returned an unreadable receipt. Do not resend; check the AgentMail console."
        : "AgentMail returned an unreadable mailbox response.");
    }
  }

  async function inboxFor(bot?: Bot) {
    if (!bot) throw new Error("Email requires a named bot. Select a bot in the web interface or use pekka bot run.");
    apiKey();
    const database = databaseFor();
    await ensureSchema(database);
    const [saved] = await database.query("SELECT inbox_id, email FROM bot_email WHERE bot_id = ?", [bot.id]);
    if (saved) return InboxSchema.parse(saved);
    const inbox = InboxSchema.parse(await post("/inboxes", {
      client_id: `pekka-bot-${bot.id}`,
      display_name: bot.name,
    }));
    await database.run(
      "INSERT INTO bot_email (bot_id, inbox_id, email) VALUES (?, ?, ?) ON CONFLICT (bot_id) DO NOTHING",
      [bot.id, inbox.inbox_id, inbox.email],
    );
    const [stored] = await database.query("SELECT inbox_id, email FROM bot_email WHERE bot_id = ?", [bot.id]);
    return InboxSchema.parse(stored);
  }

  const getEmailAddress = defineTool({
    name: "get_email_address",
    permission: { effect: "write", plugin: "agentmail" },
    description: "Get this named bot's own email address. The first call creates a permanent AgentMail inbox for the bot, using one inbox slot; later calls return the same address. This is the bot's mailbox, not the user's. Mail sent to this address cannot be read. Needs a named bot and AGENTMAIL_API_KEY on the server.",
    input: z.object({}),
    async run(_input, { bot }) {
      return JSON.stringify(await inboxFor(bot));
    },
  });

  const sendEmail = defineTool({
    name: "send_email",
    permission: { effect: "write", plugin: "agentmail" },
    description: "Send a plain-text email from this named bot's own mailbox, not the user's. Creates the mailbox on first use. Send only to recipients the user's task covers. Returns the sending address and message id; that means AgentMail accepted it, not that it was delivered. If the outcome is unknown, do not resend: check the AgentMail console first. Needs a named bot and AGENTMAIL_API_KEY on the server.",
    input: z.object({
      to: z.array(z.email()).min(1).max(50).describe("Recipient email addresses, up to 50."),
      subject: z.string().trim().min(1).max(998).regex(/^[^\r\n]+$/).describe("Single-line subject."),
      body: z.string().min(1).max(100_000).describe("Plain-text body, up to 100,000 characters."),
    }),
    async run({ to, subject, body }, { bot }) {
      const inbox = await inboxFor(bot);
      const receipt = SentSchema.safeParse(await post(`/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`, {
        to, subject, text: body,
      }, true));
      if (!receipt.success) throw new Error("AgentMail accepted the request but returned an invalid receipt. Do not resend; check the AgentMail console.");
      return JSON.stringify({ status: "accepted", from: inbox.email, to, ...receipt.data });
    },
  });

  return [getEmailAddress, sendEmail] as const;
}
