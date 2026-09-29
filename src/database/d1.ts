import { z } from "zod";

const D1ConfigSchema = z.object({
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  CLOUDFLARE_D1_DATABASE_ID: z.string().min(1),
});

export interface D1Service {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: string[],
  ): Promise<T[]>;
  checkConnection(): Promise<void>;
}

export function createD1Service(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): D1Service {
  const parsed = D1ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Missing D1 configuration: ${missing}. See .env.example.`);
  }

  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID } = parsed.data;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(CLOUDFLARE_D1_DATABASE_ID)}/query`;

  async function query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: string[] = [],
  ): Promise<T[]> {
    const response = await request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    });

    const payload: unknown = await response.json();
    const result = D1ResponseSchema.safeParse(payload);
    if (!result.success) {
      throw new Error(`Invalid D1 response (HTTP ${response.status}).`);
    }
    if (!response.ok || !result.data.success || result.data.result.some((item) => !item.success)) {
      const details = result.data.errors.map((error) => error.message).join("; ");
      throw new Error(`D1 query failed (HTTP ${response.status})${details ? `: ${details}` : "."}`);
    }
    return result.data.result.flatMap((item) => item.results) as T[];
  }

  return {
    query,
    async checkConnection() {
      await query("SELECT 1 AS ok");
    },
  };
}

const D1ResponseSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ message: z.string() })).default([]),
  result: z.array(z.object({
    success: z.boolean(),
    results: z.array(z.record(z.string(), z.unknown())).default([]),
  })).default([]),
});
