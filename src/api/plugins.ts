import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { CalendarService } from "../plugins/calendar.ts";
import type { ContactsService } from "../plugins/contacts.ts";
import type { DriveService } from "../plugins/drive.ts";
import type { GmailService } from "../plugins/gmail.ts";
import type { GitHubService } from "../plugins/github.ts";
import type { ApiKeyPlugin } from "../plugins/api-key.ts";
import type { LinearService } from "../plugins/linear.ts";
import type { NotionService } from "../plugins/notion.ts";
import type { TelegramService } from "../plugins/telegram.ts";
import type { Route } from "./auth.ts";
import { body, HttpError, json, readCookie } from "./http.ts";

import type { WisprService } from "../plugins/wispr.ts";

interface OAuthPlugin {
  status(userId: string): Promise<unknown>;
  authorize(state: string): string | Promise<string>;
  exchange(userId: string, code: string, state?: string): Promise<void>;
  setEnabled(userId: string, enabled: boolean): Promise<void>;
  disconnect(userId: string): Promise<void>;
}

/** Save-key, enable and disconnect routes for a plugin the user connects with their own API key. */
function apiKeyRoutes(plugin: ApiKeyPlugin): Route[] {
  const path = new RegExp(`^/api/plugins/${plugin.id}$`);
  return [
    ["POST", new RegExp(`^/api/plugins/${plugin.id}/connect$`), async (request, response, _params, userId) => {
      const { apiKey } = await body(request, z.object({ apiKey: z.string().trim().min(8, "That API key looks too short.").max(1000) }).strict());
      await plugin.connect(userId, apiKey);
      json(response, 200, await plugin.status(userId));
    }],
    ["PUT", path, async (request, response, _params, userId) => {
      const { enabled } = await body(request, z.object({ enabled: z.boolean() }).strict());
      await plugin.setEnabled(userId, enabled);
      json(response, 200, await plugin.status(userId));
    }],
    ["DELETE", path, async (_request, response, _params, userId) => {
      await plugin.disconnect(userId);
      json(response, 200, await plugin.status(userId));
    }],
  ];
}

/**
 * Connect, callback, enable and disconnect routes for a plugin that signs in
 * with OAuth. A connection started by one user can only be completed by them.
 */
function oauthRoutes(id: string, name: string, plugin: OAuthPlugin, origin: (request: IncomingMessage) => string): Route[] {
  const pending = new Map<string, { expires: number; userId: string }>();
  const cookieName = `pekka_${id}_state`;
  const cookiePath = `/api/plugins/${id}`;

  const stateCookie = (request: IncomingMessage) => readCookie(request, cookieName);
  const forget = (userId: string) => {
    for (const [key, value] of pending) if (value.userId === userId) pending.delete(key);
  };

  const attributes = (request: IncomingMessage) => `HttpOnly; SameSite=Lax; Path=${cookiePath}${origin(request).startsWith("https:") ? "; Secure" : ""}`;
  const clearCookie = (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Set-Cookie", `${cookieName}=; ${attributes(request)}; Max-Age=0`);
  };

  const redirect = (response: ServerResponse, result: string) => {
    response.writeHead(303, { Location: `/?${id}=${result}#plugins`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    response.end();
  };

  const connect: Route[2] = async (request, response, _params, userId) => {
    await body(request, z.object({}).strict());
    const state = randomBytes(32).toString("hex");
    const url = await plugin.authorize(state);
    const callback = new URL(new URL(url).searchParams.get("redirect_uri")!);
    if (callback.origin !== origin(request)) {
      throw new HttpError(400, `Open Pekka at ${callback.origin} to connect ${name}.`);
    }
    for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
    forget(userId);
    if (pending.size >= 100) throw new HttpError(429, "Too many connection attempts. Please try again later.");
    pending.set(state, { expires: Date.now() + 600_000, userId });
    response.setHeader("Set-Cookie", `${cookieName}=${state}; ${attributes(request)}; Max-Age=600`);
    json(response, 200, { url });
  };

  const callback: Route[2] = async (request, response, _params, userId) => {
    const query = new URL(request.url!, "http://localhost").searchParams;
    const state = query.get("state");
    clearCookie(request, response);
    const attempt = state ? pending.get(state) : undefined;
    if (!state || state !== stateCookie(request) || !attempt || attempt.expires < Date.now() || attempt.userId !== userId) {
      redirect(response, "error");
      return;
    }
    pending.delete(state);
    if (query.has("error")) {
      redirect(response, query.get("error") === "access_denied" ? "denied" : "error");
      return;
    }
    const code = query.get("code");
    if (!code || code.length > 4096) { redirect(response, "error"); return; }
    try {
      await plugin.exchange(userId, code, state);
      redirect(response, "connected");
    } catch {
      redirect(response, "error");
    }
  };

  const path = new RegExp(`^/api/plugins/${id}$`);
  return [
    ["POST", new RegExp(`^/api/plugins/${id}/connect$`), connect],
    ["GET", new RegExp(`^/api/plugins/${id}/callback$`), callback],
    ["PUT", path, async (request, response, _params, userId) => {
      const { enabled } = await body(request, z.object({ enabled: z.boolean() }).strict());
      forget(userId);
      await plugin.setEnabled(userId, enabled);
      json(response, 200, await plugin.status(userId));
    }],
    ["DELETE", path, async (request, response, _params, userId) => {
      forget(userId);
      await plugin.disconnect(userId);
      clearCookie(request, response);
      json(response, 200, await plugin.status(userId));
    }],
  ];
}

export interface PluginServices {
  wispr: WisprService;
  notion: NotionService;
  gmail: GmailService;
  calendar: CalendarService;
  drive: DriveService;
  contacts: ContactsService;
  telegram: TelegramService;
  github: GitHubService;
  linear: LinearService;
  granola: ApiKeyPlugin;
  todoist: ApiKeyPlugin;
}

export function pluginRoutes({ wispr, notion, gmail, calendar, drive, contacts, telegram, github, linear, granola, todoist }: PluginServices, origin: (request: IncomingMessage) => string): Route[] {
  const oauth: [string, string, OAuthPlugin][] = [
    ["wispr", "Wispr Flow", wispr], ["notion", "Notion", notion], ["gmail", "Gmail", gmail], ["calendar", "Google Calendar", calendar],
    ["drive", "Google Drive", drive], ["contacts", "Google Contacts", contacts], ["github", "GitHub", github], ["linear", "Linear", linear],
  ];
  return [
    ["GET", /^\/api\/plugins$/, async (_request, response, _params, userId) => {
      json(response, 200, { plugins: await Promise.all([wispr, notion, gmail, calendar, drive, contacts, telegram, github, linear, granola, todoist].map((plugin) => plugin.status(userId))) });
    }],
    ...oauth.flatMap(([id, name, plugin]) => oauthRoutes(id, name, plugin, origin)),
    ...[granola, todoist].flatMap(apiKeyRoutes),
    ["POST", /^\/api\/plugins\/telegram\/connect$/, async (request, response, _params, userId) => {
      await body(request, z.object({}).strict());
      json(response, 200, await telegram.startLink(userId));
    }],
    ["DELETE", /^\/api\/plugins\/telegram\/connect$/, async (_request, response, _params, userId) => {
      await telegram.cancelLink(userId);
      json(response, 200, await telegram.status(userId));
    }],
    ["POST", /^\/api\/plugins\/telegram\/check$/, async (request, response, _params, userId) => {
      await body(request, z.object({}).strict());
      const linked = await telegram.checkLink(userId);
      json(response, 200, { linked, ...await telegram.status(userId) });
    }],
    ["PUT", /^\/api\/plugins\/telegram$/, async (request, response, _params, userId) => {
      const { enabled } = await body(request, z.object({ enabled: z.boolean() }).strict());
      await telegram.setEnabled(userId, enabled);
      json(response, 200, await telegram.status(userId));
    }],
    ["DELETE", /^\/api\/plugins\/telegram$/, async (_request, response, _params, userId) => {
      await telegram.disconnect(userId);
      json(response, 200, await telegram.status(userId));
    }],
  ];
}
