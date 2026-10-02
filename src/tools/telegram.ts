import { z } from "zod";
import { getTelegramService, type TelegramService } from "../plugins/telegram.ts";
import { defineTool } from "./tool.ts";

export function createTelegramTools(service: TelegramService = getTelegramService()) {
  return [
    defineTool({
      name: "telegram_send_message",
      permission: { effect: "write", plugin: "telegram" },
      description: "Send a plain-text message to the user's own linked Telegram chat, for results or alerts the user asked to receive. It cannot message anyone else, read replies or send files. Formatting markup is sent as literal text and link previews are off. In a named bot's run the message starts with the bot's name, so don't add it yourself. Returns the Telegram message_id. Needs the user's Telegram plugin linked and enabled. If the outcome is uncertain, do not resend: say so, so the user can check Telegram.",
      input: z.object({ text: z.string().trim().min(1).max(3800).describe("Message text, up to 3,800 characters. Split longer reports into several messages.") }),
      async run({ text }, { userId, bot }) {
        return JSON.stringify(await service.send(userId, bot ? `${bot.name}:\n${text}` : text));
      },
    }),
  ];
}
