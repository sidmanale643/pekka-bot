import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiServer } from "./server.ts";
import { createBot } from "../bots.ts";
import { BrowserRegistry } from "../browser/browsers.ts";
import { BrowserKeys } from "../browser/keys.ts";
import type { BrowserSession } from "../browser/session.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { LOCAL_USER } from "../database/database.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let server: Server;
let base: string;
let registry: BrowserRegistry;
let botId: string;
let cloudflare: ReturnType<typeof vi.fn<typeof fetch>>;
let session: { engine: string; started: number; page: object; closed: boolean; liveView: ReturnType<typeof vi.fn>; screenshot: ReturnType<typeof vi.fn>; close(): Promise<void> };

beforeEach(async () => {
  database = createSqliteDatabase();
  ({ id: botId } = await createBot(LOCAL_USER, { name: "Scout", role: "Researches", job: "" }, database));
  session = {
    engine: "kitesurf", started: 1700000000000, page: { title: "Example Domain", url: "https://example.com/" }, closed: false,
    liveView: vi.fn(async (mode: string) => `https://live.browser.run/ui/view?mode=${mode}&wss=x`),
    screenshot: vi.fn(async () => Buffer.from("jpeg-bytes")),
    async close() { this.closed = true; },
  };
  registry = new BrowserRegistry(async () => ({ accountId: "a".repeat(32), token: "t" }), async () => session as unknown as BrowserSession);
  cloudflare = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ sessions: [] }));
  const browserKeys = new BrowserKeys({ database: () => database, env: { PEKKA_PLUGIN_KEY: "cd".repeat(32) }, fetch: cloudflare });
  server = createApiServer({ database, auth: null, browsers: registry, browserKeys });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
  database.close();
});

const status = async (body: object) => {
  const response = await fetch(`${base}/api/bots/Scout/browser`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { code: response.status, body: await response.json() };
};

const key = async (method: string, data?: object) => {
  const response = await fetch(`${base}/api/browser-key`, { method, headers: { "Content-Type": "application/json" }, body: data && JSON.stringify(data) });
  return { code: response.status, body: await response.json() };
};

it("saves, shows and removes the browser key in Settings, which turns bots' browsers on and off", async () => {
  const accountId = "0123456789abcdef0123456789abcdef";
  expect(await key("GET")).toEqual({ code: 200, body: { available: true, saved: false, accountId: "" } });
  expect((await status({})).body).toEqual({ open: false, enabled: false });
  expect((await key("PUT", { accountId: "nope", token: "cf-token-abcdefghijklmnop" })).code).toBe(400);
  cloudflare.mockResolvedValueOnce(new Response("{}", { status: 403 }));
  expect(await key("PUT", { accountId, token: "cf-token-abcdefghijklmnop" })).toMatchObject({ code: 400, body: { error: expect.stringContaining("Cloudflare rejected the token") } });
  expect(await key("PUT", { accountId, token: "cf-token-abcdefghijklmnop" })).toEqual({ code: 200, body: { available: true, saved: true, accountId } });
  expect(JSON.stringify(await key("GET"))).not.toContain("cf-token");
  expect((await status({})).body).toEqual({ open: false, enabled: true });
  expect(await key("DELETE")).toEqual({ code: 200, body: { available: true, saved: false, accountId: "" } });
  expect((await status({})).body).toEqual({ open: false, enabled: false });
});

it("says when a bot's browser isn't open", async () => {
  expect(await status({ link: "tab" })).toEqual({ code: 200, body: { open: false, enabled: false } });
  expect((await fetch(`${base}/api/bots/Scout/browser/screenshot`)).status).toBe(404);
  expect((await status({})).body).toEqual({ open: false, enabled: false });
  expect((await fetch(`${base}/api/bots/Nobody/browser`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(404);
});

it("shows the open browser's page with a Live View link, once per session, and its screenshot", async () => {
  await registry.browser(LOCAL_USER, botId);
  const live = { open: true, engine: "kitesurf", started: session.started, page: { title: "Example Domain", url: "https://example.com/" } };
  expect(await status({ link: "tab" })).toEqual({ code: 200, body: { ...live, liveView: "https://live.browser.run/ui/view?mode=tab&wss=x" } });
  // The page already has a link for this session, so no new one is made.
  expect((await status({ link: "tab", session: session.started })).body).toEqual(live);
  expect((await status({ link: "devtools", session: 1 })).body.liveView).toBe("https://live.browser.run/ui/view?mode=devtools&wss=x");
  expect(session.liveView).toHaveBeenCalledTimes(2);
  // An engine without Live View gets null, and the panel shows screenshots.
  session.liveView.mockRejectedValueOnce(new Error("'Cloudflare.getLiveView' wasn't found"));
  expect((await status({ link: "tab" })).body.liveView).toBeNull();

  const image = await fetch(`${base}/api/bots/Scout/browser/screenshot`);
  expect(image.headers.get("content-type")).toBe("image/jpeg");
  expect(image.headers.get("cache-control")).toBe("no-store");
  expect(Buffer.from(await image.arrayBuffer()).toString()).toBe("jpeg-bytes");

  await registry.close(LOCAL_USER, botId);
  expect((await status({ link: "tab" })).body).toEqual({ open: false, enabled: false });
});
