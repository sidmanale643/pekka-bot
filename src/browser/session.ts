import { setTimeout as delay } from "node:timers/promises";
import { Cdp, CdpError, type CdpClient, type CdpConnect } from "./cdp.ts";

// A bot's browser is a Cloudflare Browser Run session driven over CDP. Kitesurf, Cloudflare's
// lightweight agent browser, is the default; Chromium is there for sites Kitesurf can't render yet.
// Pages are read and used with small scripts rather than mouse and keyboard events, which keeps
// to the part of CDP both engines support.

export const ENGINES = ["kitesurf", "chromium"] as const;
export type Engine = (typeof ENGINES)[number];
export const ENGINE_NAMES: Record<Engine, string> = { kitesurf: "Kitesurf", chromium: "Chromium" };

export interface BrowserCredentials { accountId: string; token: string }

/** What a snapshot shows the model: the page's text and its numbered controls. */
export interface PageSnapshot { title: string; url: string; text: string; truncated: boolean; elements: string[]; moreElements: boolean }

export type LiveViewMode = "tab" | "devtools";

const TEXT_LIMIT = 12_000;
const ELEMENT_LIMIT = 150;

/** Numbers each visible control with data-pekka-ref, so browser_click and browser_type can find it, and returns the page's text. */
const READ_PAGE = `(({ textLimit, elementLimit }) => {
  const clean = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  for (const old of document.querySelectorAll("[data-pekka-ref]")) old.removeAttribute("data-pekka-ref");
  const body = document.body;
  // Some engines skip layout until a page is drawn; with no layout, every element counts as visible.
  const laidOut = Boolean(body && body.getBoundingClientRect().height > 0);
  const visible = (element) => {
    if (!laidOut) return true;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (box.width > 0 || box.height > 0) && style.visibility !== "hidden" && style.display !== "none";
  };
  const roleOf = (element) => {
    const role = element.getAttribute("role");
    if (role) return role;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "select";
    if (tag === "textarea" || element.isContentEditable) return "textbox";
    if (tag === "summary") return "button";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      return type === "text" ? "textbox" : type + " field";
    }
    return tag;
  };
  const labelOf = (element) => clean(
    element.getAttribute("aria-label") || (element.labels && element.labels[0] && element.labels[0].innerText) ||
    (element.tagName === "INPUT" || element.tagName === "SELECT" ? "" : element.innerText || element.textContent) ||
    element.getAttribute("placeholder") || element.getAttribute("title") || element.getAttribute("alt") ||
    (element.querySelector && element.querySelector("img[alt]") && element.querySelector("img[alt]").alt) ||
    (element.type === "submit" || element.type === "button" ? element.value : "") || element.getAttribute("name") || "",
  ).slice(0, 120);
  const selector = 'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [contenteditable=""], [contenteditable="true"]';
  const elements = [];
  let moreElements = false;
  for (const element of document.querySelectorAll(selector)) {
    if (element.disabled || !visible(element)) continue;
    if (elements.length >= elementLimit) { moreElements = true; break; }
    const ref = elements.length + 1;
    element.setAttribute("data-pekka-ref", String(ref));
    const role = roleOf(element);
    let line = "[" + ref + "] " + role + ' "' + labelOf(element) + '"';
    if (role === "link" && element.href) line += " -> " + element.href;
    if (role === "checkbox" || role === "radio") line += element.checked ? " (checked)" : " (not checked)";
    if (element.tagName === "SELECT") line += ' selected "' + clean(element.selectedOptions[0] && element.selectedOptions[0].text) + '"';
    else if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && element.type !== "password" && role !== "button" && element.value) line += ' value "' + clean(element.value).slice(0, 80) + '"';
    elements.push(line);
  }
  const text = String((body && (body.innerText || body.textContent)) || "").replace(/[ \\t]+/g, " ").replace(/\\n\\s*\\n+/g, "\\n\\n").trim();
  return { title: document.title, url: location.href, text: text.slice(0, textLimit), truncated: text.length > textLimit, elements, moreElements };
})`;

/** Clicks a numbered control. Links that open a new tab open in this one, so the bot stays on the page it clicked to. */
const CLICK = `((ref) => {
  const element = document.querySelector('[data-pekka-ref="' + ref + '"]');
  if (!element) return "missing";
  if (element.closest("a[target]")) element.closest("a[target]").removeAttribute("target");
  if (element.scrollIntoView) element.scrollIntoView({ block: "center" });
  if (element.focus) element.focus();
  element.click();
  return "ok";
})`;

/**
 * Fills a numbered field the way typing would, so frameworks that watch input events see it,
 * then presses Enter if asked: a page that handles the key itself gets it, otherwise its form is submitted.
 */
const TYPE = `((ref, text, submit) => {
  const element = document.querySelector('[data-pekka-ref="' + ref + '"]');
  if (!element) return { error: "missing" };
  if (element.scrollIntoView) element.scrollIntoView({ block: "center" });
  if (element.focus) element.focus();
  const changed = () => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (element.tagName === "SELECT") {
    const option = [...element.options].find((item) => item.text.trim() === text || item.value === text);
    if (!option) return { error: "option", options: [...element.options].map((item) => item.text.trim()).slice(0, 50) };
    element.value = option.value;
    changed();
  } else if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    const prototype = element.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text);
    changed();
  } else if (element.isContentEditable) {
    element.textContent = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
  } else return { error: "not-editable" };
  if (submit) {
    const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const unhandled = element.dispatchEvent(new KeyboardEvent("keydown", key));
    element.dispatchEvent(new KeyboardEvent("keypress", key));
    element.dispatchEvent(new KeyboardEvent("keyup", key));
    const form = element.form || element.closest("form");
    if (unhandled && form) form.requestSubmit ? form.requestSubmit() : form.submit();
  }
  return { ok: true };
})`;

/** Opens a Browser Run session over its CDP WebSocket. Kitesurf takes no keep_alive; Chromium stays up for 10 minutes between commands. */
export function browserRunUrl({ accountId }: BrowserCredentials, engine: Engine): string {
  const query = engine === "kitesurf" ? "browser=kitesurf" : "keep_alive=600000";
  return `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/devtools/browser?${query}`;
}

export class BrowserSession {
  /** The page the bot's on, as of its last action. Shown above the live view. */
  page = { title: "", url: "about:blank" };
  readonly started = Date.now();
  private ended = false;

  private constructor(readonly engine: Engine, private readonly cdp: CdpClient, private readonly target: string) {
    void cdp.closed.then(() => { this.ended = true; });
  }

  /** Starts a browser on the user's Cloudflare account and attaches to its first tab, opening one if it has none. */
  static async start(credentials: BrowserCredentials, engine: Engine = "kitesurf", connect: CdpConnect = Cdp.connect): Promise<BrowserSession> {
    let cdp: CdpClient;
    try { cdp = await connect(browserRunUrl(credentials, engine), { Authorization: `Bearer ${credentials.token}` }); }
    catch (error) {
      throw new CdpError(`Could not start a ${ENGINE_NAMES[engine]} browser on Cloudflare. Check that the token saved in Plugins has Browser Rendering Edit permission and that the account isn't over its Browser Run limits. (${error instanceof Error ? error.message : error})`);
    }
    try {
      const { targetInfos = [] } = await cdp.send<{ targetInfos?: { targetId: string; type: string }[] }>("Target.getTargets");
      let targetId = targetInfos.find((target) => target.type === "page")?.targetId;
      if (!targetId) ({ targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }));
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      return new BrowserSession(engine, cdp, sessionId);
    } catch (error) {
      cdp.close();
      throw error;
    }
  }

  get closed(): boolean { return this.ended; }

  private async evaluate<T>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.target);
    if (exceptionDetails) throw new CdpError(`The page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text ?? "unknown error"}`);
    return result?.value as T;
  }

  private call<T>(script: string, ...args: unknown[]): Promise<T> {
    return this.evaluate<T>(`${script}(...${JSON.stringify(args)})`);
  }

  /** Waits for the page to finish loading, through any navigation the last action started. */
  private async settle(): Promise<void> {
    await delay(400);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      // Evaluating fails while one document replaces another, so that counts as still loading.
      if (await this.evaluate<string>("document.readyState").catch(() => "loading") === "complete") break;
      await delay(250);
    }
    await delay(300);
  }

  async open(url: string): Promise<PageSnapshot> {
    const { errorText } = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url }, this.target, 60_000);
    if (errorText) throw new CdpError(`Could not open ${url}: ${errorText}`);
    await this.settle();
    return this.snapshot();
  }

  async snapshot(): Promise<PageSnapshot> {
    const snapshot = await this.call<PageSnapshot>(READ_PAGE, { textLimit: TEXT_LIMIT, elementLimit: ELEMENT_LIMIT });
    this.page = { title: snapshot.title, url: snapshot.url };
    return snapshot;
  }

  async click(ref: number): Promise<PageSnapshot> {
    if (await this.call<string>(CLICK, ref) === "missing") throw new CdpError(`There's no element [${ref}] on the page now. Take a new snapshot with browser_snapshot and use its numbers.`);
    await this.settle();
    return this.snapshot();
  }

  async type(ref: number, text: string, submit: boolean): Promise<PageSnapshot> {
    const result = await this.call<{ ok?: true; error?: string; options?: string[] }>(TYPE, ref, text, submit);
    if (result.error === "missing") throw new CdpError(`There's no element [${ref}] on the page now. Take a new snapshot with browser_snapshot and use its numbers.`);
    if (result.error === "option") throw new CdpError(`[${ref}] has no option "${text}". Its options are: ${result.options!.join(", ")}.`);
    if (result.error) throw new CdpError(`[${ref}] isn't a field you can type into. Use browser_click for buttons and links.`);
    if (submit) await this.settle();
    return this.snapshot();
  }

  /** A JPEG of what the page shows now, for watching an engine that has no Live View. */
  async screenshot(): Promise<Buffer> {
    const { data } = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 }, this.target);
    return Buffer.from(data, "base64");
  }

  /** A Cloudflare Live View link for this tab: `tab` to watch and take control, `devtools` to inspect it. Valid for five minutes to connect. */
  async liveView(mode: LiveViewMode): Promise<string> {
    const { devtoolsFrontendUrl } = await this.cdp.send<{ devtoolsFrontendUrl?: string }>("Cloudflare.getLiveView", { mode, expiresInMs: 300_000 }, this.target);
    if (!devtoolsFrontendUrl || new URL(devtoolsFrontendUrl).protocol !== "https:") throw new CdpError("Cloudflare didn't return a Live View link.");
    return devtoolsFrontendUrl;
  }

  /** Ends the session on Cloudflare, so it stops counting toward the account's browser time. */
  async close(): Promise<void> {
    if (this.ended) return;
    await this.cdp.send("Browser.close", {}, undefined, 5_000).catch(() => {});
    this.cdp.close();
  }
}
