import { afterEach, describe, expect, it, vi } from "vitest";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { createEmailTools } from "./email.ts";
import { defaultTools } from "./index.ts";
import { LOCAL_USER } from "../database/database.ts";

const databases: ReturnType<typeof createSqliteDatabase>[] = [];
const bot = { id: "a".repeat(24), name: "Scout", role: "Researcher", job: "Research" };
const context = { bot, computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER };
const inbox = { inbox_id: "scout@agentmail.to", email: "scout@agentmail.to" };
const receipt = { message_id: "message-1", thread_id: "thread-1" };
const email = { to: ["alice@example.com"], subject: "Report", body: "Report body" };

function setup(env: NodeJS.ProcessEnv = { AGENTMAIL_API_KEY: "secret" }) {
  const database = createSqliteDatabase();
  databases.push(database);
  const request = vi.fn<typeof fetch>();
  const tools = createEmailTools(env, request, () => database);
  const call = (name: string, args = {}, ctx = context) => executeToolCall({
    id: "call", type: "function", function: { name, arguments: JSON.stringify(args) },
  }, [...tools], ctx);
  return { database, request, tools, call };
}

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("email tools", () => {
  it("persists a mailbox across tool instances and bot renames", async () => {
    const { database, request, call } = setup();
    request.mockResolvedValueOnce(Response.json(inbox));
    expect(await call("get_email_address")).toEqual({ isError: false, output: JSON.stringify(inbox) });
    const tools = createEmailTools({ AGENTMAIL_API_KEY: "secret" }, request, () => database);
    expect(await tools[0]!.run({}, { ...context, bot: { ...bot, name: "Renamed" } })).toBe(JSON.stringify(inbox));
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toEqual({ client_id: `pekka-bot-${bot.id}`, display_name: "Scout" });
    expect(defaultTools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_email_address", "send_email"]));
  });

  it("uses the same creation key under concurrent provisioning", async () => {
    const { request, call, database } = setup();
    request.mockImplementation(async () => Response.json(inbox));
    const results = await Promise.all([call("get_email_address"), call("get_email_address")]);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(await database.query("SELECT * FROM bot_email")).toEqual([{ bot_id: bot.id, ...inbox }]);
    for (const [, options] of request.mock.calls) {
      expect(JSON.parse(String(options!.body)).client_id).toBe(`pekka-bot-${bot.id}`);
    }
  });

  it("sends through each bot's assigned inbox and returns an acceptance receipt", async () => {
    const { request, call } = setup();
    const secondInbox = { inbox_id: "other@agentmail.to", email: "other@agentmail.to" };
    request.mockResolvedValueOnce(Response.json(inbox)).mockResolvedValueOnce(Response.json(receipt))
      .mockResolvedValueOnce(Response.json(secondInbox)).mockResolvedValueOnce(Response.json(receipt));
    const result = await call("send_email", { ...email, from: "spoof@example.com", inbox_id: "other" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual({ status: "accepted", from: inbox.email, to: email.to, ...receipt });
    expect(request.mock.calls[1]![0]).toBe("https://api.agentmail.to/v0/inboxes/scout%40agentmail.to/messages/send");
    expect(JSON.parse(String(request.mock.calls[1]![1]!.body))).toEqual({ to: email.to, subject: email.subject, text: email.body });
    expect(request.mock.calls[1]![1]!.headers).toEqual({ Authorization: "Bearer secret", "Content-Type": "application/json" });
    expect((await call("send_email", email, { ...context, bot: { ...bot, id: "b".repeat(24) } })).isError).toBe(false);
    expect(request.mock.calls[3]![0]).toBe("https://api.agentmail.to/v0/inboxes/other%40agentmail.to/messages/send");
  });

  it("rejects missing credentials, unnamed bots, and invalid recipients before network access", async () => {
    const { request, call, tools } = setup({});
    expect((await call("send_email", email)).output).toContain("AGENTMAIL_API_KEY");
    await expect(tools[0]!.run({}, { computer: context.computer, approveAction: async () => true, userId: LOCAL_USER })).rejects.toThrow("named bot");
    expect((await call("send_email", { ...email, to: ["invalid"] })).isError).toBe(true);
    expect((await call("send_email", { ...email, subject: "Hello\r\nBcc: someone@example.com" })).isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([403, 429, 500])("reports HTTP %s without exposing provider bodies or retrying", async (status) => {
    const { request, call } = setup();
    request.mockResolvedValueOnce(Response.json(inbox)).mockResolvedValueOnce(new Response("secret provider details", { status }));
    const result = await call("send_email", email);
    expect(result.isError).toBe(true);
    expect(result.output).toContain(`HTTP ${status}`);
    expect(result.output).not.toContain("secret");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a network failure with an unknown send outcome", async () => {
    const { request, call } = setup();
    request.mockResolvedValueOnce(Response.json(inbox)).mockRejectedValueOnce(new Error("secret"));
    const result = await call("send_email", email);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("outcome unknown");
    expect(result.output).not.toContain("secret");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["not json", "{}"])("does not claim success or retry an invalid receipt: %s", async (body) => {
    const { request, call } = setup();
    request.mockResolvedValueOnce(Response.json(inbox)).mockResolvedValueOnce(new Response(body));
    const result = await call("send_email", email);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Do not resend");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
