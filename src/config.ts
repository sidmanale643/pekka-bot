import { z } from "zod";

const required = z.string({ error: "is required" }).min(1, "is required");
/** Unset and empty are the same: whatever needs the key falls back, or says it's missing when used. */
const optionalKey = z.string().optional().transform((value) => value?.trim() || undefined);

const ConfigSchema = z.object({
  OPENROUTER_API_KEY: required,
  DAYTONA_API_KEY: optionalKey,
  PEKKA_MODEL: z.string().default("deepseek/deepseek-v4.1-flash"),
  PEKKA_SANDBOX_NAME: z.string().default("pekka-computer"),
  PEKKA_DOCKER_IMAGE: z.string().trim().min(1).default("python:3.13-bookworm"),
  PEKKA_MAX_STEPS: z.coerce.number().int().positive().default(30),
  PEKKA_CONTEXT_WINDOW: z.coerce.number().int().positive().optional(),
});

export interface Config {
  openRouterApiKey: string;
  /** Without it, each sandbox is a Docker container on this machine. */
  daytonaApiKey?: string;
  model: string;
  sandboxName: string;
  dockerImage: string;
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
    dockerImage: values.PEKKA_DOCKER_IMAGE,
    maxSteps: values.PEKKA_MAX_STEPS,
    contextWindow: values.PEKKA_CONTEXT_WINDOW,
  };
}
