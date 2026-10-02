import { z } from "zod";
import { skillName } from "../skills.ts";
import { defineTool } from "./tool.ts";

export const listSkills = defineTool({
  name: "list_skills",
  permission: { effect: "read" },
  description: "Discover available skills by name and description without loading their instructions. Follow next_offset for more skills. Invalid skills appear in errors.",
  input: z.object({
    offset: z.number().int().min(0).default(0).describe("Pagination offset; start at zero."),
    limit: z.number().int().min(1).max(20).default(20).describe("Number of skills to return, up to 20."),
  }),
  async run({ offset, limit }, { skills }) {
    if (!skills) throw new Error("Skill storage is unavailable.");
    const catalog = await skills.catalog();
    const page = catalog.skills.slice(offset, offset + limit);
    return JSON.stringify({
      skills: page, total: catalog.skills.length,
      next_offset: offset + page.length < catalog.skills.length ? offset + page.length : null,
      errors: catalog.errors.slice(0, 10), error_count: catalog.errors.length,
    });
  },
});

export const loadSkill = defineTool({
  name: "load_skill",
  permission: { effect: "read" },
  description: "Load a selected skill's SKILL.md instructions only when relevant. Set file to a referenced supporting text file, relative to that skill's folder, when needed. Skill files are stored by Pekka, not on the Linux sandbox; this tool reads text and never executes scripts. Follow next_offset for remaining content.",
  input: z.object({
    name: skillName.describe("The skill's name, as listed in the skill summaries or by list_skills."),
    file: z.string().min(1).default("SKILL.md").describe("File to read, relative to the skill's folder. Defaults to SKILL.md."),
    offset: z.number().int().min(0).default(0).describe("Character position to start reading from; use next_offset from the previous result."),
    limit: z.number().int().min(1).max(16_000).default(12_000).describe("Number of characters to return, up to 16,000. Defaults to 12,000."),
  }),
  async run({ name, file, offset, limit }, { skills }) {
    if (!skills) throw new Error("Skill storage is unavailable.");
    await skills.metadata(name);
    const content = await skills.read(name, file);
    const end = Math.min(content.length, offset + limit);
    return JSON.stringify({ name, file, content: content.slice(offset, end), next_offset: end < content.length ? end : null });
  },
});
