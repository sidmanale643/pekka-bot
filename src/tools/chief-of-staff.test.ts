import { afterAll, afterEach, expect, it } from "vitest";
import { CHIEF_OF_STAFF, createBot, deleteBot, ensureChiefOfStaff, findBot, listBots, updateBot } from "../bots.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";

const database = createSqliteDatabase();
afterAll(() => database.close());
afterEach(async () => { await database.run("DELETE FROM bot_profiles"); });

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
