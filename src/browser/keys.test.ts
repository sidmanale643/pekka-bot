import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { BrowserKeyInput, BrowserKeys, parseBrowserKey } from "./keys.ts";

let database: ReturnType<typeof createSqliteDatabase>;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
const env = { PEKKA_PLUGIN_KEY: "ab".repeat(32) };
const accountId = "0123456789abcdef0123456789abcdef";
const token = "cf-token-abcdefghijklmnop";

beforeEach(() => {
  database = createSqliteDatabase();
  upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ sessions: [] }));
});

afterEach(() => { database.close(); });

it("reads the account ID and token saved together, and checks what Settings sends", () => {
  expect(parseBrowserKey(`${accountId.toUpperCase()}:${token}`)).toEqual({ accountId, token });
  for (const bad of [token, `${accountId}:`, `abc:${token}`, `${accountId}:short`]) expect(() => parseBrowserKey(bad)).toThrow("32-character Cloudflare account ID");
  expect(BrowserKeyInput.safeParse({ accountId, token }).success).toBe(true);
  expect(BrowserKeyInput.safeParse({ accountId: "abc", token }).error?.issues[0]?.message).toBe("Enter your 32-character Cloudflare account ID.");
  expect(BrowserKeyInput.safeParse({ accountId, token: "short" }).error?.issues[0]?.message).toBe("That API token looks too short.");
});

it("checks the token against the account's Browser Run sessions, saves it sealed, and forgets it on removal", async () => {
  const keys = new BrowserKeys({ database: () => database, env, fetch: upstream });
  expect(await keys.status("alice")).toEqual({ available: true, saved: false, accountId: "" });
  await expect(keys.credentials("alice")).rejects.toThrow("Add your Cloudflare account ID and Browser Run token in Settings");
  await keys.save("alice", { accountId, token });
  expect(String(upstream.mock.calls[0]![0])).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/devtools/session`);
  expect(upstream.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: `Bearer ${token}` } });
  expect(await keys.status("alice")).toEqual({ available: true, saved: true, accountId });
  expect(await keys.has("bob")).toBe(false);
  expect(JSON.stringify(await database.query("SELECT * FROM plugin_accounts"))).not.toContain(token);
  expect(await keys.credentials("alice")).toEqual({ accountId, token });
  await keys.remove("alice");
  expect(await keys.has("alice")).toBe(false);
});

it("doesn't save what Cloudflare rejects, and needs the server's sealing key", async () => {
  const keys = new BrowserKeys({ database: () => database, env, fetch: upstream });
  upstream.mockResolvedValueOnce(new Response("{}", { status: 401 }));
  await expect(keys.save("alice", { accountId, token })).rejects.toThrow("Browser Rendering > Edit permission");
  upstream.mockResolvedValueOnce(new Response("{}", { status: 404 }));
  await expect(keys.save("alice", { accountId, token })).rejects.toThrow("returned HTTP 404");
  upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
  await expect(keys.save("alice", { accountId, token })).rejects.toThrow("Could not reach Cloudflare");
  expect(await keys.has("alice")).toBe(false);

  const unsealed = new BrowserKeys({ database: () => database, env: {}, fetch: upstream });
  expect(await unsealed.status("alice")).toEqual({ available: false, saved: false, accountId: "" });
  await expect(unsealed.save("alice", { accountId, token })).rejects.toThrow("PEKKA_PLUGIN_KEY");
});
