import { describe, expect, it, vi } from "vitest";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import type { GmailService } from "../plugins/gmail.ts";
import { buildMime, createGmailTools } from "./gmail.ts";
import { defaultTools } from "./index.ts";
import { LOCAL_USER } from "../database/database.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const headers = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));

function setup(respond: (path: string, method: string, data?: unknown) => unknown) {
  const request = vi.fn(async (userId: string, path: string, method: string, data?: unknown) => {
    expect(userId).toBe(LOCAL_USER);
    return respond(path, method, data);
  });
  const tools = createGmailTools({ request } as unknown as GmailService);
  const call = (name: string, args = {}) => executeToolCall({
    id: "call", type: "function", function: { name, arguments: JSON.stringify(args) },
  }, tools, { computer: new FakeComputer(), approveAction: async () => true, userId: LOCAL_USER });
  return { request, call };
}

function decodeRaw(raw: string) {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [head, body] = text.split("\r\n\r\n");
  return { head: head!, body: Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8") };
}

describe("gmail tools", () => {
  it("is registered for every bot", () => {
    expect(defaultTools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["gmail_search", "gmail_read_message", "gmail_send", "gmail_create_draft"]));
  });

  it("searches and summarises matching messages", async () => {
    const { call, request } = setup((path) => path.startsWith("/messages?")
      ? { messages: [{ id: "m1" }], nextPageToken: "next", resultSizeEstimate: 7 }
      : { id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], snippet: "Hi there", payload: { headers: headers({ From: "Alice <alice@example.com>", Subject: "Lunch", Date: "Wed, 30 Sep 2026" }) } });
    const result = await call("gmail_search", { query: "is:unread", max_results: 5 });
    expect(JSON.parse(result.output)).toEqual({
      messages: [{ id: "m1", thread_id: "t1", from: "Alice <alice@example.com>", to: "", subject: "Lunch", date: "Wed, 30 Sep 2026", snippet: "Hi there", labels: ["INBOX", "UNREAD"], unread: true }],
      next_page_token: "next", result_size_estimate: 7,
    });
    expect(request.mock.calls[0]![1]).toBe("/messages?q=is%3Aunread&maxResults=5");
    expect(request.mock.calls[1]![1]).toContain("/messages/m1?format=metadata&metadataHeaders=From");
  });

  it("reads the plain-text body, falls back to HTML and lists attachments", async () => {
    const plain = { id: "m1", threadId: "t1", payload: { mimeType: "multipart/mixed", headers: headers({ Subject: "Report" }), parts: [
      { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<p>html</p>") } }, { mimeType: "text/plain", body: { data: b64("Hello ✓") } }] },
      { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "a1", size: 1234 } },
    ] } };
    const { call } = setup(() => plain);
    const message = JSON.parse((await call("gmail_read_message", { message_id: "m1" })).output);
    expect(message).toMatchObject({ subject: "Report", body: "Hello ✓", attachments: [{ filename: "report.pdf", mime_type: "application/pdf", size: 1234 }] });

    const html = { id: "m2", threadId: "t2", payload: { mimeType: "text/html", body: { data: b64("<style>x{}</style><p>One &amp; two</p><p>Three</p>") } } };
    const { call: callHtml } = setup(() => html);
    expect(JSON.parse((await callHtml("gmail_read_message", { message_id: "m2" })).output).body).toBe("One & two\nThree");
  });

  it("sends a UTF-8 plain-text email", async () => {
    const { call, request } = setup(() => ({ id: "s1", threadId: "t9" }));
    const result = await call("gmail_send", { to: ["bob@example.com"], cc: ["carol@example.com"], subject: "Café plans", body: "See you at 5 ☕" });
    expect(JSON.parse(result.output)).toEqual({ status: "sent", id: "s1", thread_id: "t9", to: ["bob@example.com"] });
    const [, path, method, data] = request.mock.calls[0]!;
    expect([path, method]).toEqual(["/messages/send", "POST"]);
    expect(data).not.toHaveProperty("threadId");
    const { head, body } = decodeRaw((data as { raw: string }).raw);
    expect(head).toContain("To: bob@example.com\r\nCc: carol@example.com\r\n");
    expect(head).toContain(`Subject: =?UTF-8?B?${Buffer.from("Café plans").toString("base64")}?=`);
    expect(body).toBe("See you at 5 ☕");
  });

  it("threads replies with the original's headers and subject", async () => {
    const { call, request } = setup((path) => path.startsWith("/messages/orig")
      ? { id: "orig", threadId: "t1", payload: { headers: headers({ Subject: "Lunch", "Message-ID": "<a@mail>", References: "<z@mail>" }) } }
      : { id: "d1", message: { id: "m2", threadId: "t1" } });
    const result = await call("gmail_create_draft", { to: ["alice@example.com"], body: "Sounds good", reply_to_message_id: "orig" });
    expect(JSON.parse(result.output)).toEqual({ status: "drafted", draft_id: "d1", message_id: "m2", thread_id: "t1" });
    const [, path, , data] = request.mock.calls[1]!;
    expect(path).toBe("/drafts");
    const message = (data as { message: { raw: string; threadId: string } }).message;
    expect(message.threadId).toBe("t1");
    const { head } = decodeRaw(message.raw);
    expect(head).toContain("Subject: Re: Lunch\r\nIn-Reply-To: <a@mail>\r\nReferences: <z@mail> <a@mail>\r\n");
  });

  it("rejects header injection, bad addresses and subjectless new mail before sending", async () => {
    const { call, request } = setup(() => ({}));
    expect((await call("gmail_send", { to: ["bob@example.com"], subject: "Hi\r\nBcc: eve@example.com", body: "x" })).isError).toBe(true);
    expect((await call("gmail_send", { to: ["not an address"], subject: "Hi", body: "x" })).isError).toBe(true);
    expect((await call("gmail_send", { to: ["bob@example.com"], body: "x" })).output).toContain("subject is required");
    expect((await call("gmail_modify_labels", { message_id: "m1" })).isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("modifies labels on a message", async () => {
    const { call, request } = setup(() => ({ id: "m1", labelIds: ["INBOX"] }));
    expect(JSON.parse((await call("gmail_modify_labels", { message_id: "m1", remove: ["UNREAD"] })).output)).toEqual({ id: "m1", labels: ["INBOX"] });
    expect(request.mock.calls[0]).toEqual([LOCAL_USER, "/messages/m1/modify", "POST", { addLabelIds: [], removeLabelIds: ["UNREAD"] }]);
  });

  it("wraps long bodies at 76 characters", () => {
    const raw = buildMime({ to: ["a@example.com"], subject: "s", body: "x".repeat(200) });
    const lines = Buffer.from(raw, "base64url").toString().split("\r\n\r\n")[1]!.split("\r\n");
    expect(lines.every((line) => line.length <= 76)).toBe(true);
  });
});
