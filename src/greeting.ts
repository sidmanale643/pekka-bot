import { BotMemory } from "./bot-memory.ts";
import type { Bot } from "./bots.ts";
import { characterPrompt, getCharacter } from "./characters.ts";
import { getDatabase, type Database } from "./database/database.ts";
import type { Model } from "./model/model.ts";

export interface Greeting {
  message: string;
  /** Short, self-contained tasks the user can send as they are. */
  suggestions: string[];
}

const GREETING_PROMPT = `You open a chat on behalf of an AI teammate before the user has said anything. The profile below describes the teammate, not the user; you do not know the user's name, so never address them by the teammate's name or any other name.
Write one or two short sentences in the teammate's voice, speaking as the teammate in the first person. If memory does not establish who the user is and what they want, introduce yourself and ask one or two relevant questions to learn about them and how you can help, grounded in the description. Do not assume anything about the user from the teammate's profile, do not invent prior context, and return an empty suggestions array during this initial conversation. If memory already provides this context, welcome them back, ask a relevant next question or what they would like done today, and optionally propose up to three distinct tasks grounded in that memory. Do not repeat questions answered in memory. Suggestions must be instructions to the teammate, written as the user would type them, under 90 characters. Never use em dashes.
Reply with JSON only, no code fence: {"message": "...", "suggestions": ["...", "...", "..."]}`;

/** The greeting shown when the model is unavailable or replies with something unusable. */
export function fallbackGreeting(bot: Bot): Greeting {
  return { message: bot.job ? `Hi, I'm ${bot.name}. What would you like me to work on?` : `Hi, I'm ${bot.name}. Tell me a little about yourself and what you'd like help with.`, suggestions: [] };
}

export function parseGreeting(text: string, bot: Bot): Greeting {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const value = JSON.parse(json) as Partial<Greeting>;
    const message = typeof value.message === "string" ? value.message.trim().slice(0, 500) : "";
    const suggestions = (Array.isArray(value.suggestions) ? value.suggestions : [])
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim().slice(0, 200))
      .slice(0, 3);
    return message ? { message, suggestions } : { ...fallbackGreeting(bot), suggestions };
  } catch {
    return fallbackGreeting(bot);
  }
}

export async function createGreeting(bot: Bot, model: Model, database: Database = getDatabase()): Promise<Greeting> {
  const memory = new BotMemory(bot, database);
  const remembered = [];
  for (const file of ["PREFERENCES.md", "KNOWLEDGE.md"] as const) remembered.push(`${file}:\n${(await memory.read(file)).slice(0, 2000)}`);
  const profile = `Name: ${bot.name}\nRole: ${bot.role}\nDefault task: ${bot.job}\n\nMemory:\n${remembered.join("\n\n")}`;
  const { message } = await model.reply([
    { role: "system", content: GREETING_PROMPT + characterPrompt(await getCharacter(bot.id, database)) },
    { role: "user", content: profile },
  ], []);
  return parseGreeting(message.content ?? "", bot);
}
