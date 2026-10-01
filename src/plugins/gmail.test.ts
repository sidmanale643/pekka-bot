import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiServer } from "../api/server.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { GmailService } from "./gmail.ts";
import { LOCAL_USER } from "../database/database.ts";

const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
let server: Server;
let database: ReturnType<typeof createSqliteDatabase>;
let base: string;
let gmail: GmailService;
let env: NodeJS.ProcessEnv;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;

const grant = (overrides = {}) => Response.json({ access_token: "private-access", expires_in: 3600, refresh_token: "private-refresh", scope: SCOPE, ...overrides });

beforeEach(async () => {
  database = createSqliteDatabase();
  env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", PEKKA_PLUGIN_KEY: "cd".repeat(32) };
  upstream = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith("/profile")
    ? Response.json({ emailAddress: "me@gmail.com" })
    : grant());
  gmail = new GmailService({ database: () => database, env, fetch: upstream });
  server = createApiServer({ database, gmail });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env.GOOGLE_REDIRECT_URI = `${base}/api/plugins/gmail/callback`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
});

async function connect(query = "code=code") {
  const response = await fetch(`${base}/api/plugins/gmail/connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(response.status).toBe(200);
  const { url } = await response.json() as { url: string };
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const state = new URL(url).searchParams.get("state")!;
  const callback = await fetch(`${base}/api/plugins/gmail/callback?state=${state}&${query}`, { headers: { cookie }, redirect: "manual" });
  return { url: new URL(url), location: callback.headers.get("location") };
}

it("connects through Google OAuth with offline access, encrypts tokens and leaves access off", async () => {
  const { url, location } = await connect();
  expect(url.origin).toBe("https://accounts.google.com");
  expect(url.searchParams.get("scope")).toBe(SCOPE);
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(location).toContain("gmail=connected");
  const exchange = upstream.mock.calls[0]!;
  expect(String(exchange[0])).toBe("https://oauth2.googleapis.com/token");
  expect(Object.fromEntries(new URLSearchParams(String(exchange[1]!.body)))).toMatchObject({ grant_type: "authorization_code", code: "code", client_secret: "secret" });
  expect(await gmail.status(LOCAL_USER)).toMatchObject({ id: "gmail", connected: true, enabled: false, workspaceName: "me@gmail.com" });
  expect(JSON.stringify(await database.query("SELECT * FROM plugin_accounts"))).not.toContain("private-");
  await expect(gmail.request(LOCAL_USER, "/profile", "GET")).rejects.toThrow("access is off");
  await gmail.setEnabled(LOCAL_USER, true);
  expect(await gmail.request(LOCAL_USER, "/profile", "GET")).toEqual({ emailAddress: "me@gmail.com" });
  expect(upstream.mock.calls.at(-1)![1]!.headers).toMatchObject({ Authorization: "Bearer private-access" });
});

it("rejects a connection when Gmail access was unticked on the consent screen", async () => {
  upstream.mockImplementationOnce(async () => grant({ scope: "openid" }));
  expect((await connect()).location).toContain("gmail=error");
  expect((await gmail.status(LOCAL_USER)).connected).toBe(false);
});

it("refreshes an expiring token before use and after a 401, keeping the refresh token", async () => {
  await connect();
  await gmail.setEnabled(LOCAL_USER, true);
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
  try {
    upstream.mockResolvedValueOnce(grant({ access_token: "fresh", refresh_token: undefined }))
      .mockResolvedValueOnce(Response.json({ labels: [] }));
    await gmail.request(LOCAL_USER, "/labels", "GET");
    const refresh = upstream.mock.calls.at(-2)!;
    expect(Object.fromEntries(new URLSearchParams(String(refresh[1]!.body)))).toMatchObject({ grant_type: "refresh_token", refresh_token: "private-refresh" });
    expect(upstream.mock.calls.at(-1)![1]!.headers).toMatchObject({ Authorization: "Bearer fresh" });
  } finally { now.mockRestore(); }
  upstream.mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(grant({ access_token: "rotated" }))
    .mockResolvedValueOnce(Response.json({ labels: [] }));
  await gmail.request(LOCAL_USER, "/labels", "GET");
  expect(upstream.mock.calls.at(-1)![1]!.headers).toMatchObject({ Authorization: "Bearer rotated" });
});

it("asks to reconnect when Google rejects the refresh token", async () => {
  await connect();
  await gmail.setEnabled(LOCAL_USER, true);
  upstream.mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
  await expect(gmail.request(LOCAL_USER, "/labels", "GET")).rejects.toThrow("Reconnect Gmail");
});

it("revokes at Google on disconnect and only forgets credentials once revoked", async () => {
  await connect();
  upstream.mockResolvedValueOnce(Response.json({ error: "server_error" }, { status: 503 }));
  expect((await fetch(`${base}/api/plugins/gmail`, { method: "DELETE" })).status).toBe(400);
  expect(await gmail.status(LOCAL_USER)).toMatchObject({ connected: true, enabled: false });
  upstream.mockResolvedValueOnce(new Response("{}"));
  expect((await fetch(`${base}/api/plugins/gmail`, { method: "DELETE" })).status).toBe(200);
  const revoke = upstream.mock.calls.at(-1)!;
  expect(String(revoke[0])).toBe("https://oauth2.googleapis.com/revoke");
  expect(String(revoke[1]!.body)).toBe("token=private-refresh");
  expect((await gmail.status(LOCAL_USER)).connected).toBe(false);
});

it("refuses operations outside the Gmail allowlist before network access", async () => {
  await connect();
  await gmail.setEnabled(LOCAL_USER, true);
  const calls = upstream.mock.calls.length;
  await expect(gmail.request(LOCAL_USER, "/settings/forwardingAddresses", "POST", {})).rejects.toThrow("Unsupported");
  await expect(gmail.request(LOCAL_USER, "/messages/abc/../../settings", "GET")).rejects.toThrow("Unsupported");
  expect(upstream.mock.calls.length).toBe(calls);
});

it("reports Gmail API errors and shows setup without database access", async () => {
  await connect();
  await gmail.setEnabled(LOCAL_USER, true);
  upstream.mockResolvedValueOnce(Response.json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, { status: 404 }));
  await expect(gmail.request(LOCAL_USER, "/messages/missing", "GET")).rejects.toThrow("HTTP 404 NOT_FOUND: Requested entity was not found.");
  const unconfigured = new GmailService({ env: {}, database: () => { throw new Error("Must not access DB"); } });
  expect(await unconfigured.status(LOCAL_USER)).toMatchObject({ configured: false, connected: false });
});
