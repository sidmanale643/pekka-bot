import { createHash } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadAuthConfig, type AuthConfig } from "../auth.ts";
import { CHIEF_OF_STAFF, createBot, type Bot } from "../bots.ts";
import { ensureSchema, LOCAL_USER } from "../database/database.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { NotionService } from "../plugins/notion.ts";
import { createApiServer } from "./server.ts";

let server: Server;
let database: ReturnType<typeof createSqliteDatabase>;
let base: string;
let config: AuthConfig;
let google: ReturnType<typeof vi.fn<typeof fetch>>;
/** The account Google signs in next. */
let account: { sub: string; email: string; name?: string; email_verified?: boolean; hd?: string; aud?: string; nonce?: string };
let notionEnv: NodeJS.ProcessEnv;

const idToken = (claims: Record<string, unknown>) =>
  ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");

beforeEach(async () => {
  database = createSqliteDatabase();
  account = { sub: "google-owner", email: "owner@example.com", name: "Owner" };
  google = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const form = new URLSearchParams(String(init!.body));
    const { aud, nonce, ...rest } = account;
    // The nonce comes back from the authorization step through the test's `signIn` helper.
    return Response.json({ id_token: idToken({
      iss: "https://accounts.google.com", aud: aud ?? "client", exp: Math.floor(Date.now() / 1000) + 600,
      email_verified: true, hd: "example.com", nonce: nonce ?? pendingNonce, verifier: form.get("code_verifier"), ...rest,
    }) });
  });
  config = loadAuthConfig({
    PEKKA_URL: "http://127.0.0.1:1", GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret",
    PEKKA_ALLOWED_EMAILS: "@example.com", PEKKA_OWNER_EMAIL: "owner@example.com",
  })!;
  notionEnv = { NOTION_CLIENT_ID: "client", NOTION_CLIENT_SECRET: "secret", PEKKA_PLUGIN_KEY: "ab".repeat(32) };
  const notion = new NotionService({ database: () => database, env: notionEnv, fetch: async () => Response.json({ access_token: "token", workspace_name: "Team" }) });
  server = createApiServer({ database, auth: config, fetch: google, notion });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The port is only known once listening, so point the configuration at it now.
  Object.assign(config, { origin: base, host: new URL(base).host, redirectUri: `${base}/api/auth/google/callback` });
  notionEnv.NOTION_REDIRECT_URI = `${base}/api/plugins/notion/callback`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
});

let pendingNonce = "";

const cookieOf = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]!).filter((cookie) => !cookie.endsWith("="));

async function startLogin() {
  const response = await fetch(`${base}/api/auth/google`, { redirect: "manual" });
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  pendingNonce = url.searchParams.get("nonce")!;
  return { url, cookie: cookieOf(response).join("; ") };
}

/** Signs in through the whole Google flow and returns the session cookie. */
async function signIn(): Promise<string> {
  const { url, cookie } = await startLogin();
  const callback = await fetch(`${base}/api/auth/google/callback?state=${url.searchParams.get("state")}&code=code`, { headers: { cookie }, redirect: "manual" });
  expect(callback.headers.get("location")).toBe("/");
  return cookieOf(callback).join("; ");
}

function call(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json", Origin: base, cookie, ...init.headers } });
}

it("requires a session for the API but serves the page, health and session status without one", async () => {
  expect((await fetch(`${base}/`)).status).toBe(200);
  expect((await fetch(`${base}/api/health`)).status).toBe(200);
  expect(await (await fetch(`${base}/api/auth/session`)).json()).toEqual({ required: true, user: null });
  const bots = await fetch(`${base}/api/bots`);
  expect(bots.status).toBe(401);
  expect(await bots.json()).toEqual({ error: "Sign in to use Pekka." });
  expect((await call("/api/bots", "pekka_session=forged")).status).toBe(401);
});

it("signs in with Google using PKCE, state and nonce, then signs out", async () => {
  const { url, cookie } = await startLogin();
  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(url.searchParams.get("redirect_uri")).toBe(`${base}/api/auth/google/callback`);
  expect(url.searchParams.get("scope")).toBe("openid email profile");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  // A callback whose state doesn't match the browser's login cookie never reaches Google.
  const forged = await fetch(`${base}/api/auth/google/callback?state=other&code=code`, { headers: { cookie }, redirect: "manual" });
  expect(forged.headers.get("location")).toBe("/?login=error");
  expect(google).not.toHaveBeenCalled();

  const callback = await fetch(`${base}/api/auth/google/callback?state=${url.searchParams.get("state")}&code=code`, { headers: { cookie }, redirect: "manual" });
  expect(callback.headers.get("location")).toBe("/");
  const sent = new URLSearchParams(String(google.mock.calls[0]![1]!.body));
  expect(createHash("sha256").update(sent.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
  const session = cookieOf(callback).join("; ");
  expect(callback.headers.getSetCookie().find((value) => value.startsWith("pekka_session="))).toMatch(/HttpOnly; SameSite=Lax; Path=\//);
  expect(JSON.stringify(await database.query("SELECT * FROM sessions"))).not.toContain(session.split("=")[1]);

  expect(await (await call("/api/auth/session", session)).json()).toEqual({ required: true, user: { id: LOCAL_USER, email: "owner@example.com", name: "Owner" } });
  expect((await call("/api/bots", session)).status).toBe(200);
  expect((await call("/api/auth/logout", session, { method: "POST", body: "{}" })).status).toBe(200);
  expect((await call("/api/bots", session)).status).toBe(401);
});

it("refuses accounts outside the allowlist, unverified emails and tokens for another client or sign-in", async () => {
  for (const [next, reason] of [
    [{ sub: "s1", email: "stranger@elsewhere.example" }, "forbidden"],
    // A domain entry admits only that domain's Google Workspace accounts, not a personal account made with a company address.
    [{ sub: "s5", email: "former@example.com", hd: undefined }, "forbidden"],
    [{ sub: "s6", email: "former@example.com", hd: "elsewhere.example" }, "forbidden"],
    [{ sub: "s2", email: "new@example.com", email_verified: false }, "error"],
    [{ sub: "s3", email: "new@example.com", aud: "another-client" }, "error"],
    [{ sub: "s4", email: "new@example.com", nonce: "replayed" }, "error"],
  ] as const) {
    account = next;
    const { url, cookie } = await startLogin();
    const callback = await fetch(`${base}/api/auth/google/callback?state=${url.searchParams.get("state")}&code=code`, { headers: { cookie }, redirect: "manual" });
    expect(callback.headers.get("location")).toBe(`/?login=${reason}`);
    expect(cookieOf(callback)).toEqual([]);
  }
  await ensureSchema(database);
  expect(await database.query("SELECT * FROM users")).toEqual([]);
});

it("gives the owner the local data and keeps every user's bots, jobs and plugins apart", async () => {
  const legacy = await createBot(LOCAL_USER, { name: "Scout", role: "Researcher", job: "Find repos" }, database);
  const owner = await signIn();
  account = { sub: "google-teammate", email: "teammate@example.com", name: "Teammate" };
  const teammate = await signIn();

  // Each user gets their own chief of staff, listed first.
  const chief = { ...CHIEF_OF_STAFF, id: expect.any(String), primary: true };
  const ownerBots = (await (await call("/api/bots", owner)).json() as { bots: Bot[] }).bots;
  const teammateBots = (await (await call("/api/bots", teammate)).json() as { bots: Bot[] }).bots;
  expect(ownerBots).toEqual([chief, legacy]);
  expect(teammateBots).toEqual([chief]);
  expect(teammateBots[0]!.id).not.toBe(ownerBots[0]!.id);
  expect((await call("/api/bots/Scout", teammate)).status).toBe(404);
  expect((await call("/api/bots/Scout/memory/KNOWLEDGE.md", teammate)).status).toBe(404);
  // Names only need to be unique within one user's bots.
  const created = await call("/api/bots", teammate, { method: "POST", body: JSON.stringify({ name: "Scout", role: "Writer", job: "Write" }) });
  expect(created.status).toBe(201);
  expect((await (await call("/api/bots/Scout", teammate)).json() as { role: string }).role).toBe("Writer");
  expect((await (await call("/api/bots/Scout", owner)).json() as { role: string }).role).toBe("Researcher");

  const job = await (await call("/api/jobs", owner, { method: "POST", body: JSON.stringify({ name: "Daily", task: "Report", runAt: new Date(Date.now() + 60_000).toISOString(), botName: "Scout" }) })).json() as { id: string; bot: { id: string } };
  expect(job.bot.id).toBe(legacy.id);
  expect((await (await call("/api/jobs", teammate)).json() as { jobs: unknown[] }).jobs).toEqual([]);
  expect((await call(`/api/jobs/${job.id}`, teammate)).status).toBe(404);
  expect((await call(`/api/jobs/${job.id}/cancel`, teammate, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await (await call(`/api/jobs/${job.id}`, owner)).json() as { status: string }).status).toBe("pending");

  // A plugin connection started by the owner cannot be completed by the teammate.
  const connect = await call("/api/plugins/notion/connect", owner, { method: "POST", body: "{}" });
  const state = new URL((await connect.json() as { url: string }).url).searchParams.get("state");
  const stateCookie = cookieOf(connect)[0]!;
  const hijack = await fetch(`${base}/api/plugins/notion/callback?state=${state}&code=code`, { headers: { cookie: `${teammate}; ${stateCookie}` }, redirect: "manual" });
  expect(hijack.headers.get("location")).toContain("notion=error");
  const own = await fetch(`${base}/api/plugins/notion/callback?state=${state}&code=code`, { headers: { cookie: `${owner}; ${stateCookie}` }, redirect: "manual" });
  expect(own.headers.get("location")).toContain("notion=connected");
  const plugins = async (cookie: string) => ((await (await call("/api/plugins", cookie)).json()) as { plugins: { id: string; connected: boolean }[] }).plugins.find((plugin) => plugin.id === "notion");
  expect(await plugins(owner)).toMatchObject({ connected: true });
  expect(await plugins(teammate)).toMatchObject({ connected: false });
});

it("only answers on the PEKKA_URL host and rejects writes without a matching Origin", async () => {
  const session = await signIn();
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    httpRequest(`${base}/api/health`, { headers: { Host: "localhost" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject).end();
  });
  expect(hostStatus).toBe(403);
  const create = (headers: Record<string, string>) => fetch(`${base}/api/bots`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: session, ...headers }, body: JSON.stringify({ name: "A", role: "B", job: "C" }),
  });
  expect((await create({})).status).toBe(403);
  expect((await create({ Origin: "https://evil.example" })).status).toBe(403);
  expect((await create({ Origin: base })).status).toBe(201);
});
