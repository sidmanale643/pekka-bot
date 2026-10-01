import { request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createAccess } from "./auth.ts";
import { createApiServer } from "./server.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { createBot } from "../bots.ts";
import { LOCAL_USER } from "../database/database.ts";

it("shares one workspace without cookies only when public access is explicitly enabled", async () => {
  const database = createSqliteDatabase();
  const origin = "https://pekka-app.vercel.app";
  const server = createApiServer({ database, auth: null, publicOrigin: origin });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers: { host: new URL(origin).host, ...headers } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    await createBot(LOCAL_USER, { name: "Shared bot", role: "Research", job: "Read" }, database);
    const session = await call("/api/auth/session");
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body)).toEqual({ required: false, user: null, shared: true });
    for (const cookie of ["", "unrelated=visitor"]) {
      const bots = await call("/api/bots", { cookie });
      expect(bots.status).toBe(200);
      expect(JSON.parse(bots.body).bots).toHaveLength(1);
    }
    expect((await call("/api/bots", { origin: "https://other.example" })).status).toBe(403);
    expect((await call("/api/bots", { host: "other.example" })).status).toBe(403);
    const local = createAccess(undefined, () => database);
    expect(() => local.check({ headers: { host: new URL(origin).host } } as IncomingMessage)).toThrow("Only localhost");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  }
});
