import { z } from "zod";
import { getTelegramService, type TelegramService } from "../plugins/telegram.ts";
import { defineTool } from "./tool.ts";

export function createTelegramTools(service: TelegramService = getTelegramService()) {
  return [
    defineTool({
      name: "telegram_send_message",
      permission: { effect: "write", plugin: "telegram" },
      description: "Send a plain-text Telegram message to the user's linked chat, e.g. results or alerts the user asked to receive. Requires the user's enabled Telegram plugin. Messages are signed with this bot's name. Never automatically retry an uncertain send.",
      input: z.object({ text: z.string().trim().min(1).max(3800) }),
      async run({ text }, { userId, bot }) {
        return JSON.stringify(await service.send(userId, bot ? `${bot.name}:\n${text}` : text));
      },
    }),
  ];
}
