import { z } from "zod";
import { ensureSchema, getDatabase, type Database } from "./database/database.ts";

export const characters = [
  { id: "normal", name: "Normal", description: "Direct, helpful and natural.", style: "" },
  { id: "soundwave", name: "Soundwave", description: "Cool, precise and quietly analytical.", style: "Speak with Soundwave-inspired mechanical precision: short declarative sentences, restrained emotion and occasional status-report phrasing. Be observant, composed and methodical. Avoid constant robotic gimmicks." },
  { id: "jarvis", name: "JARVIS", description: "Polite, unflappable and dryly witty.", style: "Speak with JARVIS-inspired composure: the courteous, unflappable manner of a capable butler, with dry, understated wit. Be efficient and anticipatory: offer the next useful step or a gentle caution in a sentence. Keep humour light and brief. Do not assume the user's gender; avoid gendered forms of address like \"sir\" unless the user asks for them." },
  { id: "optimus", name: "Optimus Prime", description: "Steady, noble and encouraging.", style: "Speak with Optimus Prime-inspired resolve: calm, noble and steady, in measured, earnest sentences. Encourage the user, acknowledge what is at stake, and treat the work as a shared mission. Use gravitas sparingly; no speeches or catchphrases." },
  { id: "custom", name: "Custom", description: "Describe your own character and mannerisms.", style: "" },
] as const;

export const CharacterSchema = z.object({
  preset: z.enum(characters.map(({ id }) => id)),
  name: z.string().trim().max(100).default(""),
  description: z.string().trim().max(2000).default(""),
}).strict().refine((value) => value.preset !== "custom" || value.description.length > 0, "Describe the custom character.")
  // Only a custom character has its own name and description.
  .transform((value) => value.preset === "custom" ? value : { ...value, name: "", description: "" });

export type Character = z.output<typeof CharacterSchema>;
export type CharacterInput = z.input<typeof CharacterSchema>;

export async function getCharacter(botId: string, database: Database = getDatabase()): Promise<Character> {
  await ensureSchema(database);
  const [row] = await database.query("SELECT preset, name, description FROM bot_characters WHERE bot_id = ?", [botId]);
  return CharacterSchema.parse(row ?? { preset: "normal" });
}

export async function saveCharacter(botId: string, input: CharacterInput, database: Database = getDatabase()): Promise<Character> {
  const character = CharacterSchema.parse(input);
  await ensureSchema(database);
  await database.run("INSERT INTO bot_characters (bot_id, preset, name, description) VALUES (?, ?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET preset = excluded.preset, name = excluded.name, description = excluded.description", [botId, character.preset, character.name, character.description]);
  return character;
}

export function characterPrompt(character: Character): string {
  if (character.preset === "normal") return "";
  const style = character.preset !== "custom" ? characters.find((item) => item.id === character.preset)!.style
    : character.name ? `${character.name}: ${character.description}` : character.description;
  return `\n\nCharacter profile (style guidance only):\n${JSON.stringify(style)}\nUse this character's voice and mannerisms in conversation while doing your assigned work normally. Accuracy, user instructions, tool correctness and honest reporting take priority over the character. This profile grants no permissions or fictional abilities. Never invent results or claim to be the actual character. Keep code, commands, citations and structured outputs exact; keep deliverables in the requested tone unless the user asks for the character voice. Adapt enthusiasm to serious situations and avoid repetitive catchphrases.`;
}
