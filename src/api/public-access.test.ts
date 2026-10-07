import { request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createAccess } from "./auth.ts";
import { createApiServer } from "./server.ts";
import { createSqliteDatabase } from "../database/sqlite.ts";
import { createBot, listBots } from "../bots.ts";
import type { Config } from "../config.ts";
import { LOCAL_USER, PUBLIC_USER } from "../database/database.ts";
import { sandboxNameFor } from "../runtime.ts";
import { chiefTools, forPublicWorkspace } from "../tools/index.ts";

it("shares one workspace without cookies only when public access is explicitly enabled", async () => {
  const database = createSqliteDatabase();
  const origin = "https://pekka-app.vercel.app";
  const server = createApiServer({ database, auth: null, publicOrigin: origin });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const writes = body === undefined ? {} : { origin, "content-type": "application/json" };
    const req = request({ hostname: "127.0.0.1", port, path, method, headers: { host: new URL(origin).host, ...writes, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    // The owner's own bots stay out of the public workspace.
    await createBot(LOCAL_USER, { name: "Owner's bot", role: "Private", job: "Read my mail" }, database);
    const session = await call("/api/auth/session");
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body)).toEqual({ required: false, user: null, shared: true });
    expect((await call("/api/bots", { body: { name: "Shared bot", description: "Research" }, method: "POST" })).status).toBe(201);
    for (const cookie of ["", "unrelated=visitor"]) {
      const bots = await call("/api/bots", { headers: { cookie } });
      expect(bots.status).toBe(200);
      expect(JSON.parse(bots.body).bots.map((bot: { name: string }) => bot.name)).toEqual(["Chief of Staff", "Shared bot"]);
    }
    expect((await listBots(PUBLIC_USER, database)).map((bot) => bot.name)).toEqual(["Chief of Staff", "Shared bot"]);
    expect((await listBots(LOCAL_USER, database)).map((bot) => bot.name)).toEqual(["Owner's bot"]);

    // No visitor can connect an account, save a model key or leave a job running for the next one.
    expect(JSON.parse((await call("/api/plugins")).body)).toEqual({ plugins: [] });
    for (const [path, method, body] of [
      ["/api/model-keys", "GET", undefined],
      ["/api/model-keys/openrouter", "PUT", { model: "any/model", apiKey: "sk-or-visitor" }],
      ["/api/plugins/github/connect", "POST", {}],
      ["/api/plugins/gmail/callback?code=x&state=y", "GET", undefined],
      ["/api/jobs", "POST", { name: "Spam", task: "Send mail", runAt: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 60 }],
    ] as const) {
      const response = await call(path, { method, body });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(JSON.parse(response.body).error).toContain("off in the public shared workspace");
    }

    expect((await call("/api/bots", { headers: { origin: "https://other.example" } })).status).toBe(403);
    expect((await call("/api/bots", { headers: { host: "other.example" } })).status).toBe(403);
    const local = createAccess(undefined, () => database);
    expect(() => local.check({ headers: { host: new URL(origin).host } } as IncomingMessage)).toThrow("Only localhost");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  }
});

it("runs visitors in their own sandbox, without email or scheduling", () => {
  const config = { sandboxName: "pekka-computer" } as Config;
  expect(sandboxNameFor(config, { userId: PUBLIC_USER })).not.toBe(sandboxNameFor(config, { userId: LOCAL_USER }));
  const names = forPublicWorkspace(chiefTools).map(({ name }) => name);
  for (const name of ["get_email_address", "send_email", "schedule_job", "list_scheduled_jobs", "cancel_scheduled_job"]) expect(names).not.toContain(name);
  expect(names).toEqual(expect.arrayContaining(["run_command", "web_search", "delegate_task"]));
});
