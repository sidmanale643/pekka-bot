import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BotMemory } from "./bot-memory.ts";

const BotSchema = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  job: z.string().trim().min(1),
});

export type Bot = z.infer<typeof BotSchema>;

const botsPath = () => join(process.cwd(), ".pekka", "bots.json");

export async function listBots(): Promise<Bot[]> {
  let contents: string;
  try {
    contents = await readFile(botsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return z.array(BotSchema).parse(JSON.parse(contents));
}

export async function getBot(name: string): Promise<Bot> {
  const bot = (await listBots()).find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!bot) throw new Error(`No bot named "${name}". Run "pekka bot list" to see available bots.`);
  return bot;
}

export async function createBot(input: Bot): Promise<Bot> {
  const bot = BotSchema.parse(input);
  const bots = await listBots();
  if (bots.some((item) => item.name.toLowerCase() === bot.name.toLowerCase())) {
    throw new Error(`A bot named "${bot.name}" already exists.`);
  }
  await mkdir(join(process.cwd(), ".pekka"), { recursive: true });
  await new BotMemory(bot).initialize();
  await writeFile(botsPath(), JSON.stringify([...bots, bot], null, 2) + "\n", "utf8");
  return bot;
}
