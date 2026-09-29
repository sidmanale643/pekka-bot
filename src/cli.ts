import { existsSync } from "node:fs";
import type { AgentEvent } from "./agent/events.ts";
import { runAgent } from "./agent/loop.ts";
import { createBot, getBot, listBots, type Bot } from "./bots.ts";
import { connectDaytonaComputer } from "./computer/daytona-computer.ts";
import { loadConfig } from "./config.ts";
import { createOpenRouterModel } from "./model/openrouter.ts";
import { defaultTools } from "./tools/index.ts";

const USAGE = 'Usage:\n  pekka run "<task>"\n  pekka bot create --name "<name>" --role "<role>" --job "<job>"\n  pekka bot list\n  pekka bot run "<name>"';

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "bot") {
    const [action, ...botArgs] = rest;
    if (action === "create") {
      const bot = await createBot(parseBotOptions(botArgs));
      console.log(`Created bot "${bot.name}".`);
      return;
    }
    if (action === "list" && botArgs.length === 0) {
      const bots = await listBots();
      console.log(bots.length ? bots.map((bot) => `${bot.name} — ${bot.role}: ${bot.job}`).join("\n") : "No bots yet.");
      return;
    }
    if (action === "run" && botArgs.length === 1 && botArgs[0]) {
      const bot = await getBot(botArgs[0]);
      await runTask(bot.job, bot);
      return;
    }
  }
  if (command === "run" && rest.join(" ").trim()) {
    await runTask(rest.join(" ").trim());
    return;
  }
  console.error(USAGE);
  process.exitCode = 1;
}

function parseBotOptions(args: string[]): Bot {
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

async function runTask(task: string, bot?: Bot): Promise<void> {
  if (!task) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();

  console.log(`Connecting to sandbox "${config.sandboxName}"...`);
  const computer = await connectDaytonaComputer({
    apiKey: config.daytonaApiKey,
    sandboxName: config.sandboxName,
  });
  const model = createOpenRouterModel({ apiKey: config.openRouterApiKey, model: config.model });

  const result = await runAgent(task, {
    model,
    computer,
    tools: defaultTools,
    maxSteps: config.maxSteps,
    bot,
    onEvent: printEvent,
  });

  if (result.status === "step_limit") {
    console.log(`\nStopped after ${result.steps} steps without finishing (PEKKA_MAX_STEPS).`);
  }
  const { promptTokens, completionTokens, costUsd } = result.usage;
  console.log(`\n${result.steps} steps · ${promptTokens + completionTokens} tokens · $${costUsd.toFixed(4)}`);
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
