import { z } from "zod";

const required = z.string({ error: "is required" }).min(1, "is required");

const ConfigSchema = z.object({
  OPENROUTER_API_KEY: required,
  DAYTONA_API_KEY: required,
  PEKKA_MODEL: z.string().default("stealth/space-bunny-alpha"),
  PEKKA_SANDBOX_NAME: z.string().default("pekka-computer"),
  PEKKA_MAX_STEPS: z.coerce.number().int().positive().default(30),
  PEKKA_CONTEXT_WINDOW: z.coerce.number().int().positive().optional(),
});

export interface Config {
  openRouterApiKey: string;
  daytonaApiKey: string;
  model: string;
  sandboxName: string;
  maxSteps: number;
  /** Overrides the context window OpenRouter reports for the model. */
  contextWindow?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")} ${issue.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}\nSee .env.example.`);
  }

  const values = parsed.data;
  return {
    openRouterApiKey: values.OPENROUTER_API_KEY,
    daytonaApiKey: values.DAYTONA_API_KEY,
    model: values.PEKKA_MODEL,
    sandboxName: values.PEKKA_SANDBOX_NAME,
    maxSteps: values.PEKKA_MAX_STEPS,
    contextWindow: values.PEKKA_CONTEXT_WINDOW,
  };
}
