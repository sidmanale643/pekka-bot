import { z } from "zod";
import type { Database, SqlValue } from "./database.ts";

const D1ConfigSchema = z.object({
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  CLOUDFLARE_D1_DATABASE_ID: z.string().min(1),
});

/** Thrown when the Cloudflare D1 environment variables are missing. */
export class DatabaseConfigError extends Error {}

export interface D1Service extends Database {
  checkConnection(): Promise<void>;
}

export function createD1Service(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): D1Service {
  const parsed = D1ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new DatabaseConfigError(`Missing D1 configuration: ${missing}. See .env.example.`);
  }

  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID } = parsed.data;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(CLOUDFLARE_D1_DATABASE_ID)}/query`;

  async function execute(sql: string, params: SqlValue[] = []) {
    const response = await request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params: params.map(String) }),
      signal: AbortSignal.timeout(30_000),
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`D1 query failed (HTTP ${response.status}): response was not JSON.`);
    }
    const result = D1ResponseSchema.safeParse(payload);
    if (!result.success) {
      throw new Error(`Invalid D1 response (HTTP ${response.status}).`);
    }
    if (!response.ok || !result.data.success || result.data.result.some((item) => !item.success)) {
      const details = result.data.errors.map((error) => error.message).join("; ");
      throw new Error(`D1 query failed (HTTP ${response.status})${details ? `: ${details}` : "."}`);
    }
    return result.data.result;
  }

  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) {
      return (await execute(sql, params)).flatMap((item) => item.results) as T[];
    },
    async run(sql, params) {
      const results = await execute(sql, params);
      return { changes: results.reduce((total, item) => total + (item.meta?.changes ?? 0), 0) };
    },
    async checkConnection() {
      await execute("SELECT 1 AS ok");
    },
  };
}

const D1ResponseSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ message: z.string() })).default([]),
  result: z.array(z.object({
    success: z.boolean(),
    results: z.array(z.record(z.string(), z.unknown())).default([]),
    meta: z.object({ changes: z.number().optional() }).optional(),
  })).default([]),
});
