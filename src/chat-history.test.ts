import { afterEach, beforeEach, expect, it } from "vitest";
import { createBot, deleteBot, ensureChiefOfStaff, type Bot } from "./bots.ts";
import { HISTORY_LIMIT, listMessages, saveMessages } from "./chat-history.ts";
import { LOCAL_USER } from "./database/database.ts";
import { createSqliteDatabase } from "./database/sqlite.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let bot: Bot;
beforeEach(async () => {
  database = createSqliteDatabase();
  bot = await createBot(LOCAL_USER, { name: "Scout", role: "Researcher", job: "" }, database);
});
afterEach(() => { database.close(); });

const message = (id: string, time: number, extra = {}) => ({ id, time, role: "user" as const, text: id, ...extra });

it("lists a bot's messages oldest first, keeping save order for the same millisecond", async () => {
  await saveMessages(LOCAL_USER, bot.id, [message("question", 100), message("answer", 100, { role: "assistant" })], database);
  await saveMessages(LOCAL_USER, bot.id, [message("earlier", 50)], database);
  expect((await listMessages(LOCAL_USER, bot.id, database)).map((item) => item.id)).toEqual(["earlier", "question", "answer"]);
});

it("replaces a message saved again under its ID, keeping its fields and its place", async () => {
  await saveMessages(LOCAL_USER, bot.id, [message("reply", 100, { role: "assistant", pending: true, text: "" }), message("next", 100)], database);
  await saveMessages(LOCAL_USER, bot.id, [message("reply", 100, { role: "assistant", text: "Done", tools: [{ name: "web_search" }], usage: { costUsd: 0.01 } })], database);
  const [reply, next] = await listMessages(LOCAL_USER, bot.id, database);
  expect(reply).toEqual({ id: "reply", time: 100, role: "assistant", text: "Done", tools: [{ name: "web_search" }], usage: { costUsd: 0.01 } });
  expect(next!.id).toBe("next");
});

it("loads only the latest messages, and saves batches larger than one statement", async () => {
  const many = Array.from({ length: HISTORY_LIMIT + 20 }, (_, index) => message(`m${index}`, index));
  await saveMessages(LOCAL_USER, bot.id, many, database);
  const listed = await listMessages(LOCAL_USER, bot.id, database);
  expect(listed).toHaveLength(HISTORY_LIMIT);
  expect(listed[0]!.id).toBe("m20");
  expect(listed.at(-1)!.id).toBe(`m${HISTORY_LIMIT + 19}`);
});

it("keeps each user's and each bot's chat separate, and deletes a bot's chat with the bot", async () => {
  const writer = await createBot(LOCAL_USER, { name: "Writer", role: "Author", job: "" }, database);
  await saveMessages(LOCAL_USER, bot.id, [message("scout", 1)], database);
  await saveMessages(LOCAL_USER, writer.id, [message("writer", 1)], database);
  await saveMessages("someone-else", bot.id, [message("other", 1)], database);
  expect((await listMessages(LOCAL_USER, bot.id, database)).map((item) => item.id)).toEqual(["scout"]);

  await deleteBot(LOCAL_USER, bot.id, database);
  expect(await listMessages(LOCAL_USER, bot.id, database)).toEqual([]);
  expect((await listMessages(LOCAL_USER, writer.id, database)).map((item) => item.id)).toEqual(["writer"]);
  expect((await listMessages("someone-else", bot.id, database)).map((item) => item.id)).toEqual(["other"]);
});

it("keeps the chief of staff's chat, since the chief can't be deleted", async () => {
  const chief = await ensureChiefOfStaff(LOCAL_USER, database);
  await saveMessages(LOCAL_USER, chief.id, [message("hello", 1)], database);
  await deleteBot(LOCAL_USER, chief.id, database);
  expect(await listMessages(LOCAL_USER, chief.id, database)).toHaveLength(1);
});
