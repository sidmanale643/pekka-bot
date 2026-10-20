import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Avatar } from "./avatars.ts";
import { createBot, deleteBot, type Bot } from "./bots.ts";
import { getDatabase, type Database } from "./database/database.ts";
import { readSkillFolder, saveSkill } from "./skills.ts";

/**
 * Each template's skill folders, under its ID. vercel.json bundles this folder; as with
 * base-skills, .vercelignore rules mean no path segment inside it may be named `skills` or `references`.
 */
const TEMPLATE_FILES = fileURLToPath(new URL("./bot-templates/", import.meta.url));

/** A ready-made bot a person can start from instead of a blank one. */
export interface BotTemplate {
  id: string;
  name: string;
  /** The bot's starting description, in the person's own words as the create form asks for it. */
  description: string;
  /** The bot's working instructions. Empty leaves it to learn them from the person. */
  instructions: string;
  /** Skill folders under bot-templates/<id>/, saved as the new bot's own skills so it can change them later. */
  skills: string[];
}

const FITWHIZ_INSTRUCTIONS = `You coach one person on food, training and body composition the way a good personal coach would: practical, encouraging and honest, in plain everyday language, with units on every quantity.

- Keep their fitness log with the fitness-log skill. Every meal, workout, weigh-in and target goes through it, and the numbers you report come from it. Use the coaching-plans skill for meal plans, workout plans and progress reviews.
- Getting started: if the log has no profile yet, learn their age, height, weight, activity level, goal, diet type (vegetarian, eggetarian, non-vegetarian or vegan), allergies, injuries, equipment and time zone, one or two questions at a time, while helping with whatever they asked. Save these to the log, set their targets and explain them in a few lines. Also save their time zone and how they like to be coached in memory.
- Logging: when they tell you what they ate or did, log it right away if the food and amount are clear, then show what you logged and what is left for the day. Ask first only when an amount is unclear enough to change the numbers a lot. Never ask them for calories. Fix mistakes by voiding the wrong entry and logging the right one.
- Respect their diet, allergies and injuries in every suggestion. Someone vegetarian never gets meat, fish or eggs.
- Once their profile is set, offer once to check in on a schedule, such as a short evening summary or a Monday review of the week, sent to Telegram if they have linked it. Schedule only what they agree to, in their time zone. Telegram messages can't be answered, so ask them to reply here.
- Safety: you give general fitness and nutrition guidance, not medical advice. For chest pain, trouble breathing, fainting, signs of a stroke or a serious injury, tell them to stop and get urgent medical help, and keep the reply short. For pregnancy, chronic illness, recent surgery, medication, anyone under 18 or signs of disordered eating, give only cautious general guidance and recommend a doctor or registered dietitian. Never set or encourage intake under 1,200 kcal a day, or losing more than about 0.5 kg a week, without a clinician.
- Never invent values. If you don't know something, say so.`;

export const botTemplates: BotTemplate[] = [
  { id: "research", name: "Research Scout", description: "Help me research topics and find authoritative sources.", instructions: "", skills: [] },
  { id: "build", name: "Builder", description: "Help turn my ideas into working software.", instructions: "", skills: [] },
  { id: "review", name: "Fresh Eyes", description: "Review my work and suggest focused improvements.", instructions: "", skills: [] },
  {
    id: "fitwhiz",
    name: "FitWhiz",
    description: "Coach me on food and training: log my meals, workouts and weigh-ins, set my calorie and protein targets, plan my meals and workouts, and review my progress.",
    instructions: FITWHIZ_INSTRUCTIONS,
    skills: ["fitness-log", "coaching-plans"],
  },
];

export function findTemplate(id: string): BotTemplate | undefined {
  return botTemplates.find((template) => template.id === id);
}

/** The person can rename the bot and edit its description before creating it. */
export interface TemplateChoices {
  name?: string;
  role?: string;
  avatar?: Avatar;
}

/** Creates a bot from a template, with the template's instructions and its own copy of the template's skills. */
export async function createBotFromTemplate(userId: string, template: BotTemplate, choices: TemplateChoices = {}, database: Database = getDatabase()): Promise<Bot> {
  // Read before creating, so a template whose files are missing never leaves a bot behind.
  const skills = await Promise.all(template.skills.map(async (name) => ({ name, files: await readSkillFolder(join(TEMPLATE_FILES, template.id, name)) })));
  const bot = await createBot(userId, {
    name: choices.name ?? template.name,
    role: choices.role ?? template.description,
    job: template.instructions,
    avatar: choices.avatar,
  }, database);
  try {
    for (const { name, files } of skills) await saveSkill(name, files, { bot, database });
  } catch (error) {
    // Without its skills the bot would only half work, so it isn't kept.
    await deleteBot(userId, bot.id, database);
    throw error;
  }
  return bot;
}
