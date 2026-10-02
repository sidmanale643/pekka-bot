import { afterAll, afterEach, expect, it } from "vitest";
import { CHIEF_OF_STAFF, createBot, deleteBot, ensureChiefOfStaff, findBot, listBots, updateBot } from "../bots.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { createTeammate, listTeam, updateTeammate } from "./chief-of-staff.ts";
import type { ToolContext } from "./tool.ts";

const database = createSqliteDatabase();
afterAll(() => database.close());
afterEach(async () => { await database.run("DELETE FROM bot_profiles"); });
const computer = new FakeComputer();

it("gives each user one chief of staff, listed first, that can be renamed but not deleted", async () => {
  const scout = await createBot("alice", { name: "Scout", role: "Research", job: "" }, database);
  const [chief, again] = await Promise.all([ensureChiefOfStaff("alice", database), ensureChiefOfStaff("alice", database)]);
  expect(chief).toEqual({ ...CHIEF_OF_STAFF, id: chief.id, primary: true });
  expect(again).toEqual(chief);
  expect(await listBots("alice", database)).toEqual([chief, scout]);
  expect((await ensureChiefOfStaff("bob", database)).id).not.toBe(chief.id);

  const renamed = await updateBot("alice", chief.id, { name: "Alfred", role: chief.role, job: "" }, database);
  expect(renamed).toEqual({ ...chief, name: "Alfred" });
  expect(await ensureChiefOfStaff("alice", database)).toEqual(renamed);
  await deleteBot("alice", chief.id, database);
  expect(await findBot("alice", "Alfred", database)).toEqual(renamed);
});

it("promotes a bot the user already named Chief of Staff instead of duplicating it", async () => {
  const existing = await createBot("alice", { name: "chief of staff", role: "My own", job: "Keep me posted" }, database);
  expect(await ensureChiefOfStaff("alice", database)).toEqual({ ...existing, primary: true });
  expect(await listBots("alice", database)).toHaveLength(1);
});

it("lets only the chief list, create and reconfigure the user's other bots", async () => {
  const chief = await ensureChiefOfStaff("alice", database);
  const scout = await createBot("alice", { name: "Scout", role: "Research", job: "Find papers" }, database);
  const context: ToolContext = { computer, database, userId: "alice", bot: chief };

  expect(JSON.parse(await listTeam.run({}, context))).toEqual({ bots: [
    { name: chief.name, description: chief.role, instructions: "", you: true },
    { name: "Scout", description: "Research", instructions: "Find papers" },
  ] });
  expect(JSON.parse(await createTeammate.run({ name: "Writer", description: "Drafts posts" }, context)))
    .toEqual({ name: "Writer", description: "Drafts posts", instructions: "" });
  await expect(createTeammate.run({ name: "scout", description: "Again" }, context)).rejects.toThrow("already exists");
  expect(JSON.parse(await updateTeammate.run({ name: "scout", instructions: "Only arXiv" }, context)))
    .toEqual({ name: "Scout", description: "Research", instructions: "Only arXiv" });
  await expect(updateTeammate.run({ name: chief.name, description: "Changed" }, context)).rejects.toThrow("update_bot_config");
  await expect(updateTeammate.run({ name: "Missing", description: "Changed" }, context)).rejects.toThrow("No bot named");

  // Another bot, or the same tools reached by someone else's chief, can't manage this user's bots.
  await expect(listTeam.run({}, { ...context, bot: scout })).rejects.toThrow("Only the chief of staff");
  const bobsChief = await ensureChiefOfStaff("bob", database);
  await expect(updateTeammate.run({ name: "Scout", description: "Taken over" }, { ...context, userId: "bob", bot: bobsChief })).rejects.toThrow("No bot named");
  expect((await findBot("alice", "Scout", database))?.role).toBe("Research");
});
