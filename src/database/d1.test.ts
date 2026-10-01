import { describe, expect, it, vi } from "vitest";
import { createD1Service, DatabaseConfigError } from "./d1.ts";

const env = { CLOUDFLARE_API_TOKEN: "secret", CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_D1_DATABASE_ID: "db" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("D1 service", () => {
  it("sends parameters as strings and returns rows and changed-row counts", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ success: true, result: [{ success: true, results: [{ name: "Scout" }] }] }))
      .mockResolvedValueOnce(reply({ success: true, result: [{ success: true, results: [], meta: { changes: 1 } }] }));
    const database = createD1Service(env, request);
    expect(await database.query("SELECT name FROM bots WHERE version = ?", [3])).toEqual([{ name: "Scout" }]);
    expect(await database.run("DELETE FROM bots")).toEqual({ changes: 1 });
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account/d1/database/db/query");
    expect(JSON.parse(String(options?.body))).toEqual({ sql: "SELECT name FROM bots WHERE version = ?", params: ["3"] });
    expect(options?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports Cloudflare errors, non-JSON responses, and missing configuration", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ success: false, errors: [{ message: "no such table: bots" }], result: [] }, 400))
      .mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 502 }));
    const database = createD1Service(env, request);
    await expect(database.query("SELECT * FROM bots")).rejects.toThrow("D1 query failed (HTTP 400): no such table: bots");
    await expect(database.query("SELECT 1")).rejects.toThrow("D1 query failed (HTTP 502): response was not JSON.");
    expect(() => createD1Service({ CLOUDFLARE_API_TOKEN: "secret" })).toThrow(DatabaseConfigError);
  });
});
