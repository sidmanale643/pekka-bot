import { z } from "zod";
import { findBotById, updateBot } from "../bots.ts";
import { defineTool } from "./tool.ts";

export const updateBotConfig = defineTool({
  name: "update_bot_config",
  permission: { effect: "write" },
  description: "Update your own saved description and working instructions from the user's explicit requests. Applies to future chats and scheduled runs. Each field you pass replaces the saved value, so include the existing text you want to keep. This cannot change your name, permissions, credentials or another bot. Save user context and preferences with write_memory instead.",
  input: z.object({
    description: z.string().trim().min(1).max(100_000).optional().describe("What you are for. Replaces your saved description; omit to keep it."),
    instructions: z.string().trim().max(100_000).optional().describe("How you should do your work. Replaces your saved working instructions; omit to keep them."),
  }).strict(),
  async run({ description, instructions }, { bot, userId, database }) {
    if (!bot) throw new Error("Configuration is available only for named bots.");
    if (description === undefined && instructions === undefined) throw new Error("Provide description or instructions.");
    const current = await findBotById(userId, bot.id, database);
    if (!current) throw new Error("This bot was deleted or is not owned by this user.");
    const updated = await updateBot(userId, bot.id, {
      name: current.name,
      role: description ?? current.role,
      job: instructions ?? current.job,
    }, database);
    Object.assign(bot, updated);
    return JSON.stringify({ description: updated.role, instructions: updated.job });
  },
});
