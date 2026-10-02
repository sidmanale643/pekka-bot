import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../api/server.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { LOCAL_USER } from "../database/database.ts";
import { CALENDAR_SCOPES, CalendarService } from "./calendar.ts";
import { CONTACTS_SCOPES, ContactsService } from "./contacts.ts";
import { DRIVE_SCOPES, DriveService } from "./drive.ts";
import type { GoogleOptions, GoogleService } from "./google.ts";

let server: Server;
let database: ReturnType<typeof createSqliteDatabase>;
let base: string;
let env: NodeJS.ProcessEnv;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
let services: { calendar: CalendarService; drive: DriveService; contacts: ContactsService };

const grant = (scopes: string[]) => Response.json({ access_token: "private-access", expires_in: 3600, refresh_token: "private-refresh", scope: scopes.join(" ") });

// Account lookups each service makes while connecting.
function account(url: string) {
  if (url.endsWith("/calendars/primary")) return Response.json({ id: "me@example.com" });
  if (url.includes("/drive/v3/about")) return Response.json({ user: { emailAddress: "me@example.com" } });
  if (url.endsWith("/userinfo")) return Response.json({ email: "me@example.com" });
}

beforeEach(async () => {
  database = createSqliteDatabase();
  env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", PEKKA_PLUGIN_KEY: "ef".repeat(32) };
  upstream = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
  const options: GoogleOptions = { database: () => database, env, fetch: upstream };
  services = { calendar: new CalendarService(options), drive: new DriveService(options), contacts: new ContactsService(options) };
  server = createApiServer({ database, ...services });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env.GOOGLE_REDIRECT_URI = `${base}/api/plugins/gmail/callback`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
});

async function connect(id: string, scopes: string[]) {
  upstream.mockImplementation(async (url) => account(String(url)) ?? grant(scopes));
  const response = await fetch(`${base}/api/plugins/${id}/connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(response.status).toBe(200);
  const { url } = await response.json() as { url: string };
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const state = new URL(url).searchParams.get("state")!;
  const callback = await fetch(`${base}/api/plugins/${id}/callback?state=${state}&code=code`, { headers: { cookie }, redirect: "manual" });
  return { url: new URL(url), location: callback.headers.get("location") };
}

async function enabled(service: GoogleService, id: string, scopes: string[]) {
  await connect(id, scopes);
  await service.setEnabled(LOCAL_USER, true);
  upstream.mockReset();
  upstream.mockImplementation(async () => Response.json({ ok: true }));
}

describe.each([
  ["calendar", CALENDAR_SCOPES],
  ["drive", DRIVE_SCOPES],
  ["contacts", CONTACTS_SCOPES],
] as const)("%s", (id, scopes) => {
  it("connects with its scopes on its own callback, names the account and leaves access off", async () => {
    const { url, location } = await connect(id, scopes);
    expect(url.searchParams.get("scope")).toBe(scopes.join(" "));
    expect(url.searchParams.get("redirect_uri")).toBe(`${base}/api/plugins/${id}/callback`);
    expect(location).toBe(`/?${id}=connected#plugins`);
    expect(await services[id].status(LOCAL_USER)).toMatchObject({ id, connected: true, enabled: false, workspaceName: "me@example.com" });
    expect(JSON.stringify(await database.query("SELECT * FROM plugin_accounts"))).not.toContain("private-");
  });

  it("rejects a connection when any permission was unticked", async () => {
    expect((await connect(id, scopes.slice(1))).location).toBe(`/?${id}=error#plugins`);
    expect((await services[id].status(LOCAL_USER)).connected).toBe(false);
  });
});

it("needs GOOGLE_REDIRECT_URI to be Gmail's callback, which sets every Google plugin's host", async () => {
  env.GOOGLE_REDIRECT_URI = `${base}/api/plugins/calendar/callback`;
  expect(await services.calendar.status(LOCAL_USER)).toMatchObject({ configured: false });
  expect(() => services.drive.authorize("state")).toThrow("GOOGLE_REDIRECT_URI must be Pekka's /api/plugins/gmail/callback URL");
});

it("calls only allowed Calendar and Tasks endpoints and returns null for empty responses", async () => {
  await enabled(services.calendar, "calendar", CALENDAR_SCOPES);
  await services.calendar.request(LOCAL_USER, "/calendar/v3/calendars/me%40example.com/events?timeMin=x", "GET");
  expect(String(upstream.mock.calls.at(-1)![0])).toBe("https://www.googleapis.com/calendar/v3/calendars/me%40example.com/events?timeMin=x");
  await services.calendar.request(LOCAL_USER, "/tasks/v1/lists/%40default/tasks", "POST", {});
  expect(String(upstream.mock.calls.at(-1)![0])).toBe("https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks");
  upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect(await services.calendar.request(LOCAL_USER, "/calendar/v3/calendars/primary/events/abc", "DELETE")).toBeNull();
  const calls = upstream.mock.calls.length;
  for (const [path, method] of [
    ["/calendar/v3/calendars/primary", "DELETE"],
    ["/calendar/v3/calendars/primary/acl", "POST"],
    ["/calendar/v3/calendars/../events", "GET"],
    ["/calendar/v3/calendars/%2e%2e/events", "GET"],
    ["/tasks/v1/lists/%40default/tasks/abc", "DELETE"],
  ] as const) {
    await expect(services.calendar.request(LOCAL_USER, path, method)).rejects.toThrow("Unsupported Google Calendar operation");
  }
  expect(upstream.mock.calls.length).toBe(calls);
});

it("keeps Drive read-only while allowing Docs and Sheets edits", async () => {
  await enabled(services.drive, "drive", DRIVE_SCOPES);
  await services.drive.request(LOCAL_USER, "/v4/spreadsheets/abc/values/%27Q3%20budget%27%21A1%3AB2:append?valueInputOption=RAW", "POST", {});
  expect(String(upstream.mock.calls.at(-1)![0])).toBe("https://sheets.googleapis.com/v4/spreadsheets/abc/values/%27Q3%20budget%27%21A1%3AB2:append?valueInputOption=RAW");
  await services.drive.request(LOCAL_USER, "/v1/documents/abc:batchUpdate", "POST", {});
  expect(String(upstream.mock.calls.at(-1)![0])).toBe("https://docs.googleapis.com/v1/documents/abc:batchUpdate");
  upstream.mockResolvedValueOnce(new Response("Hello from Drive"));
  expect((await services.drive.download(LOCAL_USER, "/drive/v3/files/abc/export?mimeType=text%2Fplain", 100)).toString()).toBe("Hello from Drive");
  upstream.mockResolvedValueOnce(new Response("x".repeat(101), { headers: { "Content-Length": "101" } }));
  await expect(services.drive.download(LOCAL_USER, "/drive/v3/files/abc?alt=media", 100)).rejects.toThrow("larger than 0 MB");
  upstream.mockResolvedValueOnce(new Response(new Blob(["x".repeat(101)]).stream()));
  await expect(services.drive.download(LOCAL_USER, "/drive/v3/files/abc?alt=media", 100)).rejects.toThrow("did not download it");
  for (const [path, method] of [
    ["/drive/v3/files/abc", "DELETE"],
    ["/drive/v3/files/abc", "PATCH"],
    ["/drive/v3/files/abc/permissions", "POST"],
    ["/drive/v3/files", "POST"],
  ] as const) {
    await expect(services.drive.request(LOCAL_USER, path, method)).rejects.toThrow("Unsupported Google Drive operation");
  }
});

it("reports Google API errors with the plugin's name", async () => {
  await enabled(services.contacts, "contacts", CONTACTS_SCOPES);
  upstream.mockResolvedValueOnce(Response.json({ error: { message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" } }, { status: 429 }));
  await expect(services.contacts.request(LOCAL_USER, "/v1/people:searchContacts?query=a", "GET")).rejects.toThrow("Google Contacts request failed (HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded.)");
  await expect(services.contacts.request(LOCAL_USER, "/v1/people/me", "GET")).rejects.toThrow("Unsupported");
  await services.contacts.setEnabled(LOCAL_USER, false);
  await expect(services.contacts.request(LOCAL_USER, "/v1/people:searchContacts?query=a", "GET")).rejects.toThrow("Google Contacts access is off");
});
