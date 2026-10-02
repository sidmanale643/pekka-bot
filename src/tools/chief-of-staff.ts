import { z } from "zod";
import { createBot, findBot, listBots, updateBot, type Bot } from "../bots.ts";
import { defineTool, type ToolContext } from "./tool.ts";

// Tools the chief of staff uses to run the user's other bots. Only the chief
// is given them, and each checks again in case one is ever listed elsewhere.

function chief({ bot }: ToolContext): Bot {
  if (!bot?.primary) throw new Error("Only the chief of staff can manage other bots.");
  return bot;
}

/** Another of the user's bots. The chief cannot target itself. */
async function teammate(context: ToolContext, name: string): Promise<Bot> {
  const self = chief(context);
  const bot = await findBot(context.userId, name, context.database);
  if (!bot) throw new Error(`No bot named "${name}". Use list_bots to see the user's bots.`);
  if (bot.id === self.id) throw new Error("That is you. Do the work yourself, and use update_bot_config to change your own configuration.");
  return bot;
}

function preview(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length)}… [truncated]`;
}

const profile = (bot: Bot) => ({ name: bot.name, description: bot.role, instructions: bot.job });

const botDescription = z.string().trim().min(1).max(100_000);
const botInstructions = z.string().trim().max(100_000);

export const listTeam = defineTool({
  name: "list_bots",
  permission: { effect: "read" },
  description: "List the user's bots with their descriptions and working instructions, to decide which one should handle a task. You are the entry marked you: true.",
  input: z.object({}).strict(),
  async run(_input, context) {
    const self = chief(context);
    const bots = await listBots(context.userId, context.database);
    return JSON.stringify({
      bots: bots.map((bot) => ({
        name: bot.name,
        description: preview(bot.role, 500),
        instructions: preview(bot.job, 500),
        ...(bot.id === self.id ? { you: true } : {}),
      })),
    });
  },
});

export const createTeammate = defineTool({
  name: "create_bot",
  permission: { effect: "write" },
  description: "Create a new bot for the user. It gets its own workspace and memory. Only create one when the user asks for it or agrees to your suggestion. Give it a clear description and, if known, working instructions; it learns the rest when the user chats with it.",
  input: z.object({
    name: z.string().trim().min(1).max(200).describe("Short name, unique among the user's bots, e.g. \"Researcher\"."),
    description: botDescription.describe("What the bot is for."),
    instructions: botInstructions.optional().describe("How it should do its work. Omit to let it learn from the user."),
  }).strict(),
  async run(input, context) {
    chief(context);
    const bot = await createBot(context.userId, { name: input.name, role: input.description, job: input.instructions ?? "" }, context.database);
    return JSON.stringify(profile(bot));
  },
});

export const updateTeammate = defineTool({
  name: "update_bot",
  permission: { effect: "write" },
  description: "Change another bot's description or working instructions when the user asks. Applies from that bot's next run, including scheduled runs. Preserve useful existing instructions. Use update_bot_config for your own configuration.",
  input: z.object({
    name: z.string().trim().min(1).describe("The bot's name, from list_bots."),
    description: botDescription.optional().describe("What the bot is for. Replaces its saved description; omit to keep it."),
    instructions: botInstructions.optional().describe("How it should do its work. Replaces its saved working instructions; omit to keep them."),
  }).strict(),
  async run(input, context) {
    const bot = await teammate(context, input.name);
    if (input.description === undefined && input.instructions === undefined) throw new Error("Provide description or instructions.");
    const updated = await updateBot(context.userId, bot.id, {
      name: bot.name,
      role: input.description ?? bot.role,
      job: input.instructions ?? bot.job,
    }, context.database);
    return JSON.stringify(profile(updated));
  },
});

export const chiefOfStaffTools = [listTeam, createTeammate, updateTeammate];
