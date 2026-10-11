import { expect, it, vi } from "vitest";
import { BrowserRegistry } from "../browser/browsers.ts";
import type { BrowserSession, Engine, PageSnapshot } from "../browser/session.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { createBrowserTools } from "./browser.ts";
import { defaultTools, unnamedTools, withBrowser } from "./index.ts";
import type { Tool } from "./tool.ts";

const page = (title: string): PageSnapshot => ({ title, url: `https://example.com/${title}`, text: `${title} text`, truncated: false, elements: ['[1] link "Next" -> https://example.com/next', '[2] textbox "Search"'], moreElements: false });

/** A browser that records what it was asked to do. */
function fakeSession(engine: Engine) {
  let closed = false;
  const session = {
    engine, page: { title: "", url: "about:blank" }, started: Date.now(),
    get closed() { return closed; },
    open: vi.fn(async (url: string) => page(new URL(url).pathname.slice(1) || "home")),
    snapshot: vi.fn(async () => page("again")),
    click: vi.fn(async () => page("clicked")),
    type: vi.fn(async () => page("typed")),
    close: vi.fn(async () => { closed = true; }),
    end() { closed = true; },
  };
  return session;
}

function setup() {
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const credentials = vi.fn(async () => ({ accountId: "a".repeat(32), token: "t" }));
  const registry = new BrowserRegistry(credentials, async (_credentials, engine) => {
    const session = fakeSession(engine);
    sessions.push(session);
    return session as unknown as BrowserSession;
  });
  const tools: Record<string, Tool> = Object.fromEntries(createBrowserTools(registry).map((tool) => [tool.name, tool]));
  const context = { computer: new FakeComputer(), userId: "alice", bot: { id: "bot-1", name: "Scout" } as never };
  return { sessions, credentials, registry, tools, context };
}

it("are built-in tools that a run gets only with the user's browser key", () => {
  const browserNames = (tools: Tool[]) => tools.filter((tool) => tool.name.startsWith("browser_")).map((tool) => tool.name);
  expect(browserNames(withBrowser(defaultTools, true))).toEqual(["browser_open", "browser_snapshot", "browser_click", "browser_type"]);
  expect(browserNames(withBrowser(unnamedTools, true))).toHaveLength(4);
  expect(browserNames(withBrowser(defaultTools, false))).toEqual([]);
  expect(withBrowser(defaultTools, false)).toHaveLength(defaultTools.length - 4);
  expect(defaultTools.filter((tool) => tool.name.startsWith("browser_")).every((tool) => !tool.permission?.plugin)).toBe(true);
});

it("opens one browser per bot on first use, reads pages and acts by element number", async () => {
  const { sessions, tools, context } = setup();
  await expect(tools.browser_snapshot!.run({}, context)).rejects.toThrow("Your browser isn't open. Open a page with browser_open first.");
  const opened = await tools.browser_open!.run({ url: "https://example.com/start" }, context);
  expect(opened).toBe([
    "Browser: Kitesurf", "Title: start", "URL: https://example.com/start", "", "Page text:", "start text", "",
    "Elements (use the number with browser_click or browser_type):", '[1] link "Next" -> https://example.com/next', '[2] textbox "Search"',
  ].join("\n"));
  expect(await tools.browser_click!.run({ ref: 1 }, context)).toContain("Title: clicked");
  expect(await tools.browser_type!.run({ ref: 2, text: "pekka", submit: true }, context)).toContain("Title: typed");
  expect(await tools.browser_snapshot!.run({}, context)).toContain("Title: again");
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.click).toHaveBeenCalledWith(1);
  expect(sessions[0]!.type).toHaveBeenCalledWith(2, "pekka", true);
  // Another bot gets its own browser.
  await tools.browser_open!.run({ url: "https://example.com/other" }, { ...context, bot: { id: "bot-2", name: "Ada" } as never });
  expect(sessions).toHaveLength(2);
});

it("shares one browser between tools called at once, and starts a fresh one for another engine or after it ended", async () => {
  const { sessions, tools, context, credentials } = setup();
  await Promise.all([tools.browser_open!.run({ url: "https://example.com/a" }, context), tools.browser_open!.run({ url: "https://example.com/b" }, context)]);
  expect(sessions).toHaveLength(1);
  expect(credentials).toHaveBeenCalledTimes(1);

  const switched = await tools.browser_open!.run({ url: "https://example.com/video", engine: "chromium" }, context);
  expect(switched).toMatch(/^This is a fresh browser session, so earlier pages, sign-ins and form entries are gone\./);
  expect(switched).toContain("Browser: Chromium");
  expect(sessions[0]!.close).toHaveBeenCalled();
  expect(sessions[1]!.engine).toBe("chromium");

  sessions[1]!.end();
  await expect(tools.browser_click!.run({ ref: 1 }, context)).rejects.toThrow("Your browser isn't open");
  await tools.browser_open!.run({ url: "https://example.com/again" }, context);
  // A restart keeps the engine the bot last chose.
  expect(sessions[2]!.engine).toBe("chromium");
});

it("closes a run's browser when asked, and keeps no failed start", async () => {
  const { sessions, registry, tools, context, credentials } = setup();
  await tools.browser_open!.run({ url: "https://example.com/a" }, context);
  expect(await registry.find("alice", "bot-1")).toBe(sessions[0]);
  await registry.close("alice", "bot-1");
  expect(sessions[0]!.close).toHaveBeenCalled();
  expect(await registry.find("alice", "bot-1")).toBeUndefined();

  credentials.mockRejectedValueOnce(new Error("Cloudflare Browser Run access is off."));
  await expect(tools.browser_open!.run({ url: "https://example.com/a" }, context)).rejects.toThrow("access is off");
  expect(await registry.find("alice", "bot-1")).toBeUndefined();
  await tools.browser_open!.run({ url: "https://example.com/a" }, context);
  expect(sessions).toHaveLength(2);
});

it("only opens HTTP and HTTPS pages", async () => {
  const { tools, context } = setup();
  await expect(tools.browser_open!.run({ url: "file:///etc/passwd" }, context)).rejects.toThrow();
  await expect(tools.browser_open!.run({ url: "javascript:alert(1)" }, context)).rejects.toThrow();
});
