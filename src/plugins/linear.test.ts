import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { LinearService, OPERATIONS, type LinearOperation } from "./linear.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let service: LinearService;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;

const form = (call: Parameters<typeof fetch>) => Object.fromEntries(new URLSearchParams(call[1]!.body as string));
const graphql = (call: Parameters<typeof fetch>) => JSON.parse(call[1]!.body as string) as { query: string; variables: unknown };
const calls = (path: string) => upstream.mock.calls.filter(([url]) => String(url) === `https://api.linear.app${path}`);

beforeEach(() => {
  database = createSqliteDatabase();
  upstream = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 86_399 });
    if (String(url).endsWith("/oauth/revoke")) return new Response(null, { status: 200 });
    const { query } = JSON.parse(init!.body as string) as { query: string };
    return Response.json({ data: query === OPERATIONS.viewer ? { viewer: { id: "u1", name: "Ada", organization: { name: "Acme" } } } : { issues: { nodes: [] } } });
  });
  service = new LinearService({ database: () => database, env: { LINEAR_CLIENT_ID: "client", LINEAR_CLIENT_SECRET: "secret", LINEAR_REDIRECT_URI: "http://localhost:3000/api/plugins/linear/callback", PEKKA_PLUGIN_KEY: "ab".repeat(32) }, fetch: upstream });
});

afterEach(() => { vi.restoreAllMocks(); database.close(); });

async function connect(user = "alice") {
  await service.exchange(user, "code", "browser-state");
  await service.setEnabled(user, true);
}

it("exchanges the PKCE verifier, encrypts credentials and requires explicit access", async () => {
  const url = new URL(service.authorize("browser-state"));
  expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
  expect(url.searchParams.get("scope")).toBe("read,write");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  await service.exchange("alice", "code", "browser-state");
  const sent = form(calls("/oauth/token")[0]!);
  expect(sent).toMatchObject({ grant_type: "authorization_code", code: "code", client_id: "client", client_secret: "secret", redirect_uri: "http://localhost:3000/api/plugins/linear/callback" });
  expect(createHash("sha256").update(sent.code_verifier!).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
  expect(calls("/graphql")[0]![1]).toMatchObject({ headers: { Authorization: "Bearer private-access" } });
  expect(await service.status("alice")).toMatchObject({ id: "linear", connected: true, enabled: false, workspaceName: "Acme" });
  expect(JSON.stringify(await database.query("SELECT * FROM plugin_accounts"))).not.toContain("private-");
  await expect(service.request("alice", "issues", { first: 5 })).rejects.toThrow("access is off");
  expect(calls("/graphql")).toHaveLength(1);
  await service.setEnabled("alice", true);
  await service.request("alice", "issues", { first: 5 });
  expect(calls("/graphql")).toHaveLength(2);
});

it("rejects missing exchange state and keeps tenant connections isolated", async () => {
  await expect(service.exchange("alice", "code")).rejects.toThrow("state is missing");
  expect(upstream).not.toHaveBeenCalled();
  await connect();
  expect(await service.status("bob")).toMatchObject({ connected: false, enabled: false });
  await expect(service.setEnabled("bob", true)).rejects.toThrow("Connect Linear");
  await expect(service.request("bob", "issues", { first: 5 })).rejects.toThrow("access is off");
  await service.disconnect("bob");
  expect(await service.status("alice")).toMatchObject({ connected: true, enabled: true });
});

it("sends only its fixed GraphQL operations, with the caller's variables", async () => {
  await connect();
  await expect(service.request("alice", "deleteIssue" as LinearOperation)).rejects.toThrow("Unsupported Linear operation");
  await expect(service.request("alice", "__proto__" as LinearOperation)).rejects.toThrow("Unsupported Linear operation");
  expect(calls("/graphql")).toHaveLength(1);
  await service.request("alice", "updateIssue", { id: "ENG-1", input: { stateId: "s1" } });
  expect(graphql(calls("/graphql")[1]!)).toEqual({ query: OPERATIONS.updateIssue, variables: { id: "ENG-1", input: { stateId: "s1" } } });
});

it("fails on GraphQL errors, including ones Linear sends with HTTP 200", async () => {
  await connect();
  upstream.mockResolvedValueOnce(Response.json({ data: null, errors: [{ message: "Entity not found: Issue" }] }));
  await expect(service.request("alice", "issue", { id: "ENG-404" })).rejects.toThrow("HTTP 200: Entity not found: Issue");
  upstream.mockResolvedValueOnce(Response.json({ errors: [{ message: "Rate limit exceeded" }] }, { status: 400 }));
  await expect(service.request("alice", "issue", { id: "ENG-1" })).rejects.toThrow("Do not automatically retry a write");
  upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
  await expect(service.request("alice", "issue", { id: "ENG-1" })).rejects.toThrow("Could not reach Linear");
});

it("refreshes expiring tokens once and saves the rotated pair", async () => {
  upstream.mockResolvedValueOnce(Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 1 }));
  await connect();
  upstream.mockResolvedValueOnce(Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 86_399 }));
  await service.request("alice", "issues", { first: 5 });
  expect(form(calls("/oauth/token")[1]!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "private-refresh" });
  expect(calls("/graphql").at(-1)![1]).toMatchObject({ headers: { Authorization: "Bearer rotated-access" } });
  await service.request("alice", "issues", { first: 5 });
  expect(calls("/oauth/token")).toHaveLength(2);
  expect(JSON.stringify(await database.query("SELECT * FROM plugin_accounts"))).not.toContain("rotated-");
  // A refresh Linear refuses means the user must reconnect.
  upstream.mockResolvedValueOnce(Response.json({ access_token: "a", refresh_token: "r", expires_in: 1 }));
  await connect("bob");
  upstream.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
  await expect(service.request("bob", "issues", { first: 5 })).rejects.toThrow("Reconnect Linear");
});

it("keeps disabled credentials when revocation fails, and drops them when Linear can't revoke the token", async () => {
  await connect();
  upstream.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
  await expect(service.disconnect("alice")).rejects.toThrow("revocation failed");
  expect(await service.status("alice")).toMatchObject({ connected: true, enabled: false });
  await expect(service.request("alice", "issues", { first: 5 })).rejects.toThrow("access is off");
  upstream.mockResolvedValueOnce(new Response("Unable to revoke", { status: 400 }));
  await service.disconnect("alice");
  expect(await service.status("alice")).toMatchObject({ connected: false, enabled: false });
  expect(form(calls("/oauth/revoke").at(-1)!)).toEqual({ token: "private-refresh", token_type_hint: "refresh_token" });
});

it("reports unconfigured status without accessing the database", async () => {
  const missing = new LinearService({ env: {}, database: () => { throw new Error("Unexpected DB access"); } });
  expect(await missing.status("alice")).toMatchObject({ id: "linear", configured: false, connected: false, enabled: false });
  const offsite = new LinearService({ env: { LINEAR_CLIENT_ID: "c", LINEAR_CLIENT_SECRET: "s", LINEAR_REDIRECT_URI: "https://evil.example/api/plugins/linear/callback", PEKKA_PLUGIN_KEY: "ab".repeat(32) } });
  expect(() => offsite.authorize("state")).toThrow("redirect must be Pekka's");
});
