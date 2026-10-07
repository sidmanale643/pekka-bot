import { expect, it, vi } from "vitest";
import { checkAnthropicKey, createAnthropicModel, toAnthropic } from "./anthropic.ts";
import type { ChatMessage, ToolDefinition } from "./model.ts";

const sse = (...events: Record<string, unknown>[]) => new Response(
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "Content-Type": "text/event-stream" } },
);
const start = (usage = {}) => ({ type: "message_start", message: {
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, ...usage },
} });
const text = (index: number, value: string) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index },
];
const thinking = (index: number) => [
  { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig-1" } },
  { type: "content_block_stop", index },
];
const toolUse = (index: number, id: string, input: unknown) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "read_file", input: {} } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index },
];
const end = (stop_reason: string, output_tokens = 5) => [
  { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens } },
  { type: "message_stop" },
];
const tool: ToolDefinition = { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } };

function model(name: string, ...events: Record<string, unknown>[]) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse(...events));
  return { fetch, model: createAnthropicModel({ apiKey: "sk-ant-test", model: name, fetch }) };
}
const sent = (fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>) => {
  const [url, init] = fetch.mock.calls[0]!;
  return { url: String(url), headers: new Headers(init!.headers), body: JSON.parse(init!.body as string) };
};

it("turns the loop's messages into Claude's, with each step's tool results in one user turn", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are Pekka." },
    { role: "assistant", content: "Hi! What can I do?" },
    { role: "user", content: "Read two files." },
    { role: "assistant", content: null, tool_calls: [
      { id: "t1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } },
      { id: "t2", type: "function", function: { name: "read_file", arguments: "" } },
    ] },
    { role: "tool", tool_call_id: "t1", content: "A" },
    { role: "tool", tool_call_id: "t2", content: "" },
  ];
  expect(toAnthropic(messages)).toEqual({
    system: "You are Pekka.",
    params: [
      { role: "user", content: "(Earlier conversation follows.)" },
      { role: "assistant", content: [{ type: "text", text: "Hi! What can I do?" }] },
      { role: "user", content: "Read two files." },
      { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
        { type: "tool_use", id: "t2", name: "read_file", input: {} },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: "A" },
        { type: "tool_result", tool_use_id: "t2", content: "(no output)" },
      ] },
    ],
  });
});

it("sends Claude's own blocks back unchanged, thinking included", () => {
  const raw = [{ type: "thinking", thinking: "", signature: "sig-1" }, { type: "text", text: "Done." }];
  const { params } = toAnthropic([{ role: "user", content: "Go" }, { role: "assistant", content: "Done.", raw: { provider: "anthropic", content: raw } }]);
  expect(params[1]).toEqual({ role: "assistant", content: raw });
});

it("streams text, returns tool calls and keeps the raw reply for the next request", async () => {
  const { fetch, model: claude } = model("claude-opus-5-5", start(), ...thinking(0), ...text(1, "Reading."), ...toolUse(2, "toolu_1", { path: "notes.md" }), ...end("tool_use"));
  const deltas: string[] = [];
  const reply = await claude.reply([{ role: "system", content: "Be brief." }, { role: "user", content: "Read notes.md" }], [tool], (delta) => deltas.push(delta));

  expect(deltas.join("")).toBe("Reading.");
  expect(reply.message.content).toBe("Reading.");
  expect(reply.message.tool_calls).toEqual([{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"notes.md\"}" } }]);
  expect(reply.message.raw?.content.map((block) => (block as { type: string }).type)).toEqual(["thinking", "text", "tool_use"]);
  expect(reply.usage).toEqual({ promptTokens: 100, completionTokens: 5, cachedTokens: 90, costUsd: 0 });

  const { url, headers, body } = sent(fetch);
  expect(url).toContain("/v1/messages");
  expect(headers.get("x-api-key")).toBe("sk-ant-test");
  expect(headers.get("anthropic-beta")).toBe("thinking-binding-controls-2026-08-01,server-side-fallback-2026-07-01");
  expect(body).toMatchObject({
    model: "claude-opus-5-5", stream: true, system: "Be brief.", cache_control: { type: "ephemeral" }, fallbacks: "default",
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } }, output_config: { effort: "high" },
    tools: [{ name: "read_file", description: "Read a file", input_schema: tool.function.parameters, eager_input_streaming: true }],
  });
});

it("runs older models without thinking or fallbacks", async () => {
  const { fetch, model: claude } = model("claude-haiku-4-5", start(), ...text(0, "Hi"), ...end("end_turn"));
  await claude.reply([{ role: "user", content: "Hi" }], []);
  const { headers, body } = sent(fetch);
  expect(body.thinking).toBeUndefined();
  expect(body.fallbacks).toBeUndefined();
  expect(body.tools).toBeUndefined();
  expect(headers.get("anthropic-beta")).toBeNull();
});

it("ends the turn with a note when Claude declines, without running its tool calls", async () => {
  const { model: claude } = model("claude-opus-5-5", start(), ...toolUse(0, "toolu_1", { path: "x" }), ...end("refusal"));
  const reply = await claude.reply([{ role: "user", content: "..." }], [tool]);
  expect(reply.message).toEqual({ role: "assistant", content: "Claude declined to continue with this request." });
});

it("drops the declined model's thinking and tool calls from before a mid-reply fallback", async () => {
  const fallback = { type: "content_block_start", index: 2, content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } } };
  const { model: claude } = model("claude-opus-5-5", start(), ...thinking(0), ...toolUse(1, "toolu_old", { path: "x" }),
    fallback, { type: "content_block_stop", index: 2 }, ...text(3, "Here you go."), ...end("end_turn"));
  const reply = await claude.reply([{ role: "user", content: "..." }], [tool]);
  expect(reply.message.tool_calls).toBeUndefined();
  expect(reply.message.raw?.content.map((block) => (block as { type: string }).type)).toEqual(["fallback", "text"]);
});

it("fails rather than run a tool call cut off at the token limit", async () => {
  const { model: claude } = model("claude-opus-5-5", start(), ...toolUse(0, "toolu_1", { path: "x" }), ...end("max_tokens"));
  await expect(claude.reply([{ role: "user", content: "..." }], [tool])).rejects.toThrow("limit in the middle of a tool call");
});

it("reports API errors with Anthropic's message", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }));
  const claude = createAnthropicModel({ apiKey: "bad", model: "claude-opus-5-5", fetch });
  await expect(claude.reply([{ role: "user", content: "Hi" }], [])).rejects.toThrow("Anthropic request failed (401): invalid x-api-key");
});

it("checks a key against the model and reads its context window", async () => {
  const ok = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ id: "claude-opus-5-5", type: "model", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1_000_000 }));
  await expect(checkAnthropicKey({ apiKey: "sk-ant-test", model: "claude-opus-5-5", fetch: ok })).resolves.toEqual({ contextWindow: 1_000_000 });
  expect(String(ok.mock.calls[0]![0])).toContain("/v1/models/claude-opus-5-5");

  const rejected = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ type: "error", error: { type: "authentication_error", message: "invalid" } }, { status: 401 }));
  await expect(checkAnthropicKey({ apiKey: "bad", model: "claude-opus-5-5", fetch: rejected })).rejects.toThrow("Anthropic rejected this API key.");
  const missing = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ type: "error", error: { type: "not_found_error", message: "no" } }, { status: 404 }));
  await expect(checkAnthropicKey({ apiKey: "sk-ant-test", model: "claude-nope", fetch: missing })).rejects.toThrow("no model called \"claude-nope\"");
});
