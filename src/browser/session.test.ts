import { expect, it } from "vitest";
import type { CdpClient } from "./cdp.ts";
import { BrowserSession, browserRunUrl, type PageSnapshot } from "./session.ts";

const credentials = { accountId: "a".repeat(32), token: "token-123" };
const page: PageSnapshot = { title: "Example Domain", url: "https://example.com/", text: "Example Domain", truncated: false, elements: ['[1] link "Learn more" -> https://iana.org/'], moreElements: false };

/** Stands in for Browser Run: answers each command from `answers`, by method, and records what was sent. */
function fakeBrowser(answers: Record<string, (params: any) => unknown> = {}) {
  const calls: { method: string; params?: any; sessionId?: string }[] = [];
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  const defaults: Record<string, (params: any) => unknown> = {
    "Target.getTargets": () => ({ targetInfos: [{ targetId: "worker", type: "service_worker" }, { targetId: "T1", type: "page" }] }),
    "Target.attachToTarget": () => ({ sessionId: "S1" }),
    "Page.navigate": () => ({ frameId: "F1" }),
    "Runtime.evaluate": ({ expression }) => ({ result: { value: expression === "document.readyState" ? "complete" : expression.includes("textLimit") ? page : "ok" } }),
    "Cloudflare.getLiveView": ({ mode }) => ({ devtoolsFrontendUrl: `https://live.browser.run/ui/view?mode=${mode}&wss=x` }),
  };
  const client: CdpClient = {
    send: (async (method: string, params?: any, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      const answer = answers[method] ?? defaults[method];
      return answer ? answer(params) : {};
    }) as CdpClient["send"],
    closed,
    close,
  };
  const connected: { url: string; headers: Record<string, string> }[] = [];
  return { calls, connected, connect: async (url: string, headers: Record<string, string>) => { connected.push({ url, headers }); return client; } };
}

it("starts Kitesurf with the token and attaches to its page, or Chromium with a keep-alive", async () => {
  expect(browserRunUrl(credentials, "kitesurf")).toBe(`wss://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/browser-run/devtools/browser?browser=kitesurf`);
  expect(browserRunUrl(credentials, "chromium")).toMatch(/\/devtools\/browser\?keep_alive=600000$/);
  const browser = fakeBrowser();
  const session = await BrowserSession.start(credentials, "kitesurf", browser.connect);
  expect(session.engine).toBe("kitesurf");
  expect(browser.connected).toEqual([{ url: browserRunUrl(credentials, "kitesurf"), headers: { Authorization: "Bearer token-123" } }]);
  expect(browser.calls.find((call) => call.method === "Target.attachToTarget")!.params).toEqual({ targetId: "T1", flatten: true });

  const empty = fakeBrowser({ "Target.getTargets": () => ({ targetInfos: [] }), "Target.createTarget": () => ({ targetId: "T9" }) });
  await BrowserSession.start(credentials, "chromium", empty.connect);
  expect(empty.calls.map((call) => call.method)).toEqual(["Target.getTargets", "Target.createTarget", "Target.attachToTarget"]);
  expect(empty.calls[2]!.params).toEqual({ targetId: "T9", flatten: true });
});

it("explains a browser that won't start", async () => {
  await expect(BrowserSession.start(credentials, "kitesurf", async () => { throw new Error("Could not connect to the browser."); }))
    .rejects.toThrow("Could not start a Kitesurf browser on Cloudflare. Check that the token saved in Plugins has Browser Rendering Edit permission");
});

it("opens a page in its tab and reads it, and says when a page can't load", async () => {
  const browser = fakeBrowser();
  const session = await BrowserSession.start(credentials, "kitesurf", browser.connect);
  expect(await session.open("https://example.com")).toEqual(page);
  expect(session.page).toEqual({ title: "Example Domain", url: "https://example.com/" });
  const navigate = browser.calls.find((call) => call.method === "Page.navigate")!;
  expect(navigate).toMatchObject({ params: { url: "https://example.com" }, sessionId: "S1" });
  expect(browser.calls.filter((call) => call.method === "Runtime.evaluate").every((call) => call.sessionId === "S1")).toBe(true);

  const failing = fakeBrowser({ "Page.navigate": () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }) });
  const other = await BrowserSession.start(credentials, "kitesurf", failing.connect);
  await expect(other.open("https://nowhere.invalid")).rejects.toThrow("Could not open https://nowhere.invalid: net::ERR_NAME_NOT_RESOLVED");
});

it("clicks and types by element number, and says what to do when an element is gone", async () => {
  let clicked = "ok";
  let typed: object = { ok: true };
  const browser = fakeBrowser({
    "Runtime.evaluate": ({ expression }) => {
      if (expression === "document.readyState") return { result: { value: "complete" } };
      if (expression.includes("textLimit")) return { result: { value: page } };
      if (expression.includes("element.click()")) return { result: { value: clicked } };
      return { result: { value: typed } };
    },
  });
  const session = await BrowserSession.start(credentials, "kitesurf", browser.connect);
  expect(await session.click(1)).toEqual(page);
  expect(browser.calls.at(-1)!.params.expression).toContain("textLimit");
  expect(browser.calls.some((call) => call.params?.expression?.includes("element.click()") && call.params.expression.endsWith("(...[1])"))).toBe(true);
  await session.type(2, 'say "hi"', true);
  expect(browser.calls.some((call) => call.params?.expression?.endsWith('(...[2,"say \\"hi\\"",true])'))).toBe(true);

  clicked = "missing";
  await expect(session.click(7)).rejects.toThrow("There's no element [7] on the page now. Take a new snapshot with browser_snapshot");
  typed = { error: "option", options: ["Red", "Blue"] };
  await expect(session.type(3, "Green", false)).rejects.toThrow('[3] has no option "Green". Its options are: Red, Blue.');
  typed = { error: "not-editable" };
  await expect(session.type(4, "x", false)).rejects.toThrow("isn't a field you can type into");
});

it("reports script errors from the page", async () => {
  const browser = fakeBrowser({ "Runtime.evaluate": () => ({ exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } } }) });
  const session = await BrowserSession.start(credentials, "kitesurf", browser.connect);
  await expect(session.snapshot()).rejects.toThrow("The page script failed: TypeError: boom");
});

it("asks Cloudflare for a Live View link, takes screenshots and closes the browser", async () => {
  const browser = fakeBrowser({ "Page.captureScreenshot": () => ({ data: Buffer.from("jpeg").toString("base64") }) });
  const session = await BrowserSession.start(credentials, "chromium", browser.connect);
  expect(await session.liveView("devtools")).toBe("https://live.browser.run/ui/view?mode=devtools&wss=x");
  expect(browser.calls.at(-1)).toEqual({ method: "Cloudflare.getLiveView", params: { mode: "devtools", expiresInMs: 300_000 }, sessionId: "S1" });
  expect((await session.screenshot()).toString()).toBe("jpeg");
  expect(session.closed).toBe(false);
  await session.close();
  expect(browser.calls.at(-1)!.method).toBe("Browser.close");
  await Promise.resolve();
  expect(session.closed).toBe(true);
  await session.close();
  expect(browser.calls.filter((call) => call.method === "Browser.close")).toHaveLength(1);

  const unsafe = fakeBrowser({ "Cloudflare.getLiveView": () => ({ devtoolsFrontendUrl: "javascript:alert(1)" }) });
  await expect((await BrowserSession.start(credentials, "kitesurf", unsafe.connect)).liveView("tab")).rejects.toThrow("didn't return a Live View link");
});
