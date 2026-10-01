import { expect, it } from "vitest";
import { createNotionTools } from "./notion.ts";
import { defaultTools } from "./index.ts";
import { NotionService } from "../plugins/notion.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { LOCAL_USER } from "../database/database.ts";

it("registers Notion tools and sends validated page writes only while enabled", async () => {
  const database = createSqliteDatabase();
  const calls: { url: string; data: unknown }[] = [];
  const service = new NotionService({
    database: () => database,
    env: { NOTION_CLIENT_ID: "client", NOTION_CLIENT_SECRET: "secret", NOTION_REDIRECT_URI: "http://127.0.0.1:3000/api/plugins/notion/callback", PEKKA_PLUGIN_KEY: "ab".repeat(32) },
    fetch: async (url, init) => {
      calls.push({ url: String(url), data: init?.body ? JSON.parse(init.body as string) : null });
      return Response.json(String(url).endsWith("/oauth/token") ? { access_token: "token" } : { object: "page", id: "a".repeat(32) });
    },
  });
  try {
    const tools = createNotionTools(service);
    expect(defaultTools.filter((tool) => tool.name.startsWith("notion_")).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    const call = { id: "1", type: "function" as const, function: { name: "notion_create_page", arguments: JSON.stringify({ parent_page_id: "a".repeat(32), title: "Notes", text: "Hello" }) } };
    const context = { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER };
    await service.exchange(LOCAL_USER, "code");
    expect((await executeToolCall(call, tools, context)).isError).toBe(true);
    expect(calls).toHaveLength(1);
    await service.setEnabled(LOCAL_USER, true);
    expect((await executeToolCall(call, tools, context)).isError).toBe(false);
    expect(calls[1]).toMatchObject({ url: "https://api.notion.com/v1/pages", data: {
      parent: { page_id: "a".repeat(32) }, properties: { title: { title: [{ text: { content: "Notes" } }] } },
      children: [{ paragraph: { rich_text: [{ text: { content: "Hello" } }] } }],
    } });
    call.function.arguments = JSON.stringify({ parent_page_id: "a".repeat(32), title: "Notes", text: `${"a".repeat(1999)}😀b` });
    expect((await executeToolCall(call, tools, context)).isError).toBe(false);
    const chunks = (calls[2]!.data as { children: { paragraph: { rich_text: { text: { content: string } }[] } }[] }).children
      .map((block) => block.paragraph.rich_text[0]!.text.content);
    expect(chunks).toEqual([`${"a".repeat(1999)}😀`, "b"]);
    call.function.arguments = JSON.stringify({ parent_page_id: "https://evil.example", title: "Notes", text: "Hello" });
    expect((await executeToolCall(call, tools, context)).isError).toBe(true);
    expect(calls).toHaveLength(3);
  } finally { database.close(); }
});
