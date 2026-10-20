import { afterEach, beforeEach, expect, it } from "vitest";
import { botTemplates, createBotFromTemplate, findTemplate } from "./bot-templates.ts";
import { createBot, DuplicateBotError, ensureChiefOfStaff, listBots } from "./bots.ts";
import { FakeComputer } from "./computer/fake-computer.ts";
import { LOCAL_USER } from "./database/database.ts";
import { createSqliteDatabase } from "./database/sqlite.ts";
import { SkillStore } from "./skills.ts";
import { createTeammate } from "./tools/chief-of-staff.ts";
import { copySkillFile } from "./tools/skills.ts";
import type { ToolContext } from "./tools/tool.ts";

let database: ReturnType<typeof createSqliteDatabase>;
beforeEach(() => { database = createSqliteDatabase(); });
afterEach(() => database.close());

const fitwhiz = findTemplate("fitwhiz")!;

it("ships every template's skills, each loading under its own name", async () => {
  for (const template of botTemplates) {
    const bot = await createBotFromTemplate(LOCAL_USER, template, {}, database);
    expect(bot).toMatchObject({ name: template.name, role: template.description, job: template.instructions });
    const { skills, errors } = await new SkillStore(bot, database).catalog();
    expect(errors).toEqual([]);
    expect(skills.filter((skill) => skill.source === "bot").map((skill) => skill.name).sort()).toEqual([...template.skills].sort());
  }
});

it("gives a FitWhiz bot its coaching instructions, log script and food table", async () => {
  const bot = await createBotFromTemplate(LOCAL_USER, fitwhiz, { name: "Coach", role: "Get me to 75 kg" }, database);
  expect(bot).toMatchObject({ name: "Coach", role: "Get me to 75 kg", job: fitwhiz.instructions });
  expect(bot.job).toContain("fitness-log skill");

  const store = new SkillStore(bot, database);
  const script = await store.read("fitness-log", "scripts/fitwhiz.py");
  expect(script).toMatch(/^VERSION = "1"$/m);
  expect(await store.read("fitness-log", "SKILL.md")).toContain("doesn't print `1`");
  const foods = await store.read("fitness-log", "data/indian-foods.csv");
  expect(foods.split("\n")[0]).toMatch(/^id,name,/);
  expect(foods).toContain("\nplain_roti,");
});

it("keeps no bot when the name is taken", async () => {
  await createBot(LOCAL_USER, { name: "FitWhiz", role: "Mine", job: "" }, database);
  await expect(createBotFromTemplate(LOCAL_USER, fitwhiz, {}, database)).rejects.toBeInstanceOf(DuplicateBotError);
  expect((await listBots(LOCAL_USER, database)).map((bot) => bot.role)).toEqual(["Mine"]);
});

it("copies a skill file onto the computer exactly as stored", async () => {
  const bot = await createBotFromTemplate(LOCAL_USER, fitwhiz, {}, database);
  const skills = new SkillStore(bot, database);
  const computer = new FakeComputer();
  const context: ToolContext = { computer, database, userId: LOCAL_USER, bot, skills };
  const result = await copySkillFile.run({ name: "fitness-log", file: "scripts/fitwhiz.py", path: "fitwhiz/fitwhiz.py" }, context);
  expect(computer.files.get("fitwhiz/fitwhiz.py")).toBe(await skills.read("fitness-log", "scripts/fitwhiz.py"));
  expect(result).toContain("to fitwhiz/fitwhiz.py");
  await expect(copySkillFile.run({ name: "fitness-log", file: "../coaching-plans/SKILL.md", path: "x" }, context)).rejects.toThrow("inside its skill folder");
  await expect(copySkillFile.run({ name: "missing", file: "SKILL.md", path: "x" }, context)).rejects.toThrow('No skill named "missing"');
});

it("lets the chief of staff start a bot from a template", async () => {
  const chief = await ensureChiefOfStaff(LOCAL_USER, database);
  const context: ToolContext = { computer: new FakeComputer(), database, userId: LOCAL_USER, bot: chief, approveAction: async () => true };
  const created = JSON.parse(await createTeammate.run({ name: "Coach", template: "fitwhiz" }, context));
  expect(created).toEqual({ name: "Coach", description: fitwhiz.description, instructions: fitwhiz.instructions, skills: fitwhiz.skills });
  await expect(createTeammate.run({ name: "Other", template: "fitwhiz", instructions: "Do it my way" }, context)).rejects.toThrow("brings its own instructions");
  await expect(createTeammate.run({ name: "Blank" }, context)).rejects.toThrow("Give the bot a description");
  expect(createTeammate.description).toContain("fitwhiz (FitWhiz)");
  // Templates without instructions or skills only prefill the create form.
  expect(createTeammate.description).not.toContain("research (Research Scout)");
});
