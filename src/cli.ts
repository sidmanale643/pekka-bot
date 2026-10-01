import { existsSync } from "node:fs";
import type { AgentEvent } from "./agent/events.ts";
import { runAgent, type AgentResult } from "./agent/loop.ts";
import { createBot, getBot, listBots, type Bot, type BotProfile } from "./bots.ts";
import { connectDaytonaComputer } from "./computer/daytona-computer.ts";
import { loadConfig } from "./config.ts";
import { createOpenRouterModel } from "./model/openrouter.ts";
import { defaultTools } from "./tools/index.ts";
import { cancelScheduledJob, listScheduledJobs, runScheduler } from "./scheduler.ts";
import { LOCAL_USER } from "./database/database.ts";

const USAGE = 'Usage:\n  pekka run "<task>"\n  pekka bot create --name "<name>" --role "<role>" --job "<job>"\n  pekka bot list\n  pekka bot run "<name>"\n  pekka scheduler [--once]\n  pekka jobs list\n  pekka jobs cancel "<id>"';

async function main(args: string[]): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const [command, ...rest] = args;
  const commands: Record<string, (args: string[]) => Promise<unknown>> = {
    run: async (args) => {
      const task = args.join(" ").trim();
      if (!task) throw new Error(USAGE);
      return runTask(task);
    },
    bot: manageBots,
    jobs: manageJobs,
    scheduler: async (args) => {
      if (args.length > 1 || (args.length === 1 && args[0] !== "--once")) throw new Error(USAGE);
      await startScheduler(args[0] === "--once");
    },
  };
  if (!command || !Object.hasOwn(commands, command)) throw new Error(USAGE);
  await commands[command]!(rest);
}

async function manageBots(args: string[]): Promise<void> {
  const [action, ...botArgs] = args;
  if (action === "create") {
    const bot = await createBot(LOCAL_USER, parseBotOptions(botArgs));
    console.log(`Created bot "${bot.name}".`);
    return;
  }
  if (action === "list" && botArgs.length === 0) {
    const bots = await listBots(LOCAL_USER);
    console.log(bots.length ? bots.map((bot) => `${bot.name} — ${bot.role}: ${bot.job}`).join("\n") : "No bots yet.");
    return;
  }
  if (action === "run" && botArgs.length === 1 && botArgs[0]) {
    const bot = await getBot(LOCAL_USER, botArgs[0]);
    await runTask(bot.job, bot);
    return;
  }
  throw new Error(USAGE);
}

function parseBotOptions(args: string[]): BotProfile {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !["--name", "--role", "--job"].includes(key) || !value || value.startsWith("--") || values[key]) {
      throw new Error(USAGE);
    }
    values[key] = value;
  }
  if (!values["--name"] || !values["--role"] || !values["--job"]) {
    throw new Error(USAGE);
  }
  return { name: values["--name"], role: values["--role"], job: values["--job"] };
}

async function runTask(task: string, bot?: Bot): Promise<AgentResult> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();

  const sandboxName = bot ? `${config.sandboxName.slice(0, 30)}-bot-${bot.id}` : config.sandboxName;
  console.log(`Connecting to sandbox "${sandboxName}"...`);
  const computer = await connectDaytonaComputer({
    apiKey: config.daytonaApiKey,
    sandboxName,
    workspace: Boolean(bot),
  });
  const model = createOpenRouterModel({ apiKey: config.openRouterApiKey, model: config.model });

  const result = await runAgent(task, {
    model,
    computer,
    tools: defaultTools,
    maxSteps: config.maxSteps,
    userId: LOCAL_USER,
    bot,
    onEvent: printEvent,
  });

  if (result.status === "step_limit") {
    console.log(`\nStopped after ${result.steps} steps without finishing (PEKKA_MAX_STEPS).`);
  }
  const { promptTokens, completionTokens, cacheHitRate, costUsd } = result.usage;
  const cache = cacheHitRate == null ? "unavailable" : `${(cacheHitRate * 100).toFixed(1)}%`;
  console.log(`\n${result.steps} steps · ${promptTokens} input tokens · ${completionTokens} output tokens · Cache hit rate: ${cache} · $${costUsd.toFixed(4)}`);
  return result;
}

async function manageJobs(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "list") {
    console.log(JSON.stringify(await listScheduledJobs(), null, 2));
    return;
  }
  if (args.length === 2 && args[0] === "cancel" && args[1]) {
    console.log(JSON.stringify(await cancelScheduledJob(args[1]), null, 2));
    return;
  }
  throw new Error(USAGE);
}

async function startScheduler(once: boolean): Promise<void> {
  const controller = new AbortController();
  const stop = () => {
    console.log("\nStopping scheduler after the current task finishes...");
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Scheduler checking jobs in ${process.cwd()}/.pekka${once ? " once" : "; keep this process running"}.`);
  try {
    await runScheduler(async (job) => {
      console.log(`\nRunning scheduled job "${job.name}" (${job.id})...`);
      const { status, answer, steps, usage } = await runTask(job.task, job.bot);
      return { status, answer, steps, usage };
    }, { once, signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

let streamingText = false;

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "step":
      streamingText = false;
      console.log(`\n── step ${event.step} ──`);
      break;
    case "message_delta":
      process.stdout.write(event.text);
      streamingText = true;
      break;
    case "message":
      if (streamingText) console.log();
      else console.log(event.text);
      streamingText = false;
      break;
    case "tool_call":
      if (streamingText) {
        console.log();
        streamingText = false;
      }
      console.log(`→ ${event.name} ${event.arguments}`);
      break;
    case "tool_result":
      console.log(indent(event.isError ? `✗ ${event.output}` : preview(event.output)));
      break;
  }
}

/** Shows the first few lines of a tool's output. */
function preview(text: string, maxLines = 8): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n");
}

function indent(text: string): string {
  return text.replace(/^/gm, "  ");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
