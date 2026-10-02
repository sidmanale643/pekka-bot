import { existsSync } from "node:fs";
import type { AgentEvent } from "./agent/events.ts";
import type { AgentResult } from "./agent/loop.ts";
import { createBot, ensureChiefOfStaff, getBot, listBots, type BotProfile } from "./bots.ts";
import { closeDocuments } from "./documents.ts";
import { loadConfig } from "./config.ts";
import { executeTask, sandboxNameFor, type RunOwner } from "./runtime.ts";
import { cancelScheduledJob, listScheduledJobs, runScheduler } from "./scheduler.ts";
import { getDatabase, LOCAL_USER } from "./database/database.ts";
import { importLocalData } from "./database/import-local.ts";
import { readSkillFolder, removeSkill, saveSkill, SkillStore } from "./skills.ts";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ApproveAction } from "./permissions/policy.ts";

const USAGE = 'Usage:\n  pekka run "<task>"\n  pekka bot create --name "<name>" --description "<description>"\n  pekka bot list\n  pekka bot run "<name>"\n  pekka scheduler [--once]\n  pekka jobs list\n  pekka jobs cancel "<id>"\n  pekka skills add "<folder>" [--bot "<name>"]\n  pekka skills list [--bot "<name>"]\n  pekka skills remove "<name>" [--bot "<name>"]\n  pekka db check\n  pekka db import';

async function main(args: string[]): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const [command, ...rest] = args;
  const commands: Record<string, (args: string[]) => Promise<unknown>> = {
    run: async (args) => {
      const task = args.join(" ").trim();
      if (!task) throw new Error(USAGE);
      return runTask(task, { userId: LOCAL_USER });
    },
    bot: manageBots,
    jobs: manageJobs,
    db: manageDatabase,
    skills: manageSkills,
    scheduler: async (args) => {
      if (args.length > 1 || (args.length === 1 && args[0] !== "--once")) throw new Error(USAGE);
      await startScheduler(args[0] === "--once");
    },
  };
  if (!command || !Object.hasOwn(commands, command)) throw new Error(USAGE);
  await commands[command]!(rest);
}

// The CLI always acts as the local user. Bots and jobs that people create
// after signing in to the web interface belong to them and are not listed here.

async function manageBots(args: string[]): Promise<void> {
  const [action, ...botArgs] = args;
  if (action === "create") {
    const bot = await createBot(LOCAL_USER, parseBotOptions(botArgs));
    console.log(`Created bot "${bot.name}".`);
    return;
  }
  if (action === "list" && botArgs.length === 0) {
    await ensureChiefOfStaff(LOCAL_USER);
    const bots = await listBots(LOCAL_USER);
    console.log(bots.map((bot) => `${bot.name}${bot.primary ? " (chief of staff)" : ""} — ${bot.role}${bot.job ? `: ${bot.job}` : ""}`).join("\n"));
    return;
  }
  if (action === "run" && botArgs.length === 1 && botArgs[0]) {
    const bot = await getBot(LOCAL_USER, botArgs[0]);
    if (!bot.job) throw new Error("This bot has no saved working instructions yet. Open it in the web interface and tell it what you need.");
    await runTask(bot.job, { userId: LOCAL_USER, bot });
    return;
  }
  throw new Error(USAGE);
}

function parseBotOptions(args: string[]): BotProfile {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !["--name", "--description", "--role", "--job"].includes(key) || !value || value.startsWith("--") || values[key]) {
      throw new Error(USAGE);
    }
    values[key] = value;
  }
  if (values["--name"] && values["--description"] && !values["--role"] && !values["--job"]) {
    return { name: values["--name"], role: values["--description"], job: "" };
  }
  if (!values["--name"] || !values["--role"] || !values["--job"] || values["--description"]) {
    throw new Error(USAGE);
  }
  return { name: values["--name"], role: values["--role"], job: values["--job"] };
}

async function runTask(task: string, owner: RunOwner): Promise<AgentResult> {
  const config = loadConfig();

  console.log(`Connecting to sandbox "${sandboxNameFor(config, owner)}"...`);
  const result = await executeTask(task, { ...owner, approveAction: terminalReviewer() }, printEvent);

  if (result.status === "step_limit") {
    console.log(`\nStopped after ${result.steps} steps without finishing (PEKKA_MAX_STEPS).`);
  }
  const { promptTokens, completionTokens, cacheHitRate, costUsd } = result.usage;
  const cache = cacheHitRate == null ? "unavailable" : `${(cacheHitRate * 100).toFixed(1)}%`;
  console.log(`\n${result.steps} steps · ${promptTokens} input tokens · ${completionTokens} output tokens · Cache hit rate: ${cache} · $${costUsd.toFixed(4)}`);
  return result;
}

function terminalReviewer(): ApproveAction | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  let queue = Promise.resolve();
  return (action) => {
    const decision = queue.then(async () => {
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(`\nPermission required: ${action.tool}\n${action.reason}\n${JSON.stringify(action.arguments, null, 2)}`);
        const answer = await reader.question("Approve this action once? [y/N] ", { signal: AbortSignal.timeout(300_000) });
        return answer.trim().toLowerCase() === "y";
      } catch { return false; }
      finally { reader.close(); }
    });
    queue = decision.then(() => {});
    return decision;
  };
}

async function manageJobs(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "list") {
    console.log(JSON.stringify(await listScheduledJobs(LOCAL_USER), null, 2));
    return;
  }
  if (args.length === 2 && args[0] === "cancel" && args[1]) {
    console.log(JSON.stringify(await cancelScheduledJob(LOCAL_USER, args[1]), null, 2));
    return;
  }
  throw new Error(USAGE);
}

async function manageDatabase(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "check") {
    await getDatabase().query("SELECT 1 AS ok");
    console.log("Connected to Cloudflare D1.");
    return;
  }
  if (args.length === 1 && args[0] === "import") {
    const { bots, memoryFiles, skills, jobs } = await importLocalData();
    console.log(`Imported from ${process.cwd()}/.pekka:`);
    console.log(`  ${bots.imported} bots (${bots.skipped} already in D1)`);
    console.log(`  ${memoryFiles} memory files`);
    console.log(`  ${skills.imported} skills (${skills.skipped} already in D1)`);
    console.log(`  ${jobs.imported} scheduled jobs (${jobs.skipped} already in D1)`);
    for (const error of skills.errors) console.log(`  Skipped skill ${error}`);
    return;
  }
  throw new Error(USAGE);
}

/** Skills are shared by every bot unless --bot limits one to a single bot. */
async function manageSkills(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const botIndex = rest.indexOf("--bot");
  const botName = botIndex === -1 ? undefined : rest[botIndex + 1];
  if (botIndex !== -1 && !botName) throw new Error(USAGE);
  const positional = botIndex === -1 ? rest : rest.filter((_, index) => index !== botIndex && index !== botIndex + 1);
  const bot = botName ? await getBot(LOCAL_USER, botName) : undefined;
  const scope = bot ? `for ${bot.name}` : "for every bot";
  if (action === "add" && positional.length === 1) {
    const folder = resolve(positional[0]!);
    const skill = await saveSkill(basename(folder), await readSkillFolder(folder), { bot });
    console.log(`Saved skill "${skill.name}" ${scope}.`);
    return;
  }
  if (action === "list" && positional.length === 0) {
    const { skills, errors } = await new SkillStore(bot).catalog();
    console.log(skills.length ? skills.map((skill) => `${skill.name} — ${skill.description}`).join("\n") : "No skills yet.");
    for (const error of errors) console.log(`Invalid: ${error}`);
    return;
  }
  if (action === "remove" && positional.length === 1) {
    await removeSkill(positional[0]!, { bot });
    console.log(`Removed skill "${positional[0]}" ${scope}.`);
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
  console.log(`Scheduler checking jobs in D1${once ? " once" : "; keep this process running"}.`);
  try {
    await runScheduler(async (job) => {
      console.log(`\nRunning scheduled job "${job.name}" (${job.id})...`);
      // Each job runs as the user who created it, with their own plugins and sandbox.
      const { status, answer, steps, usage } = await runTask(job.task, { userId: job.userId, bot: job.bot });
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
    case "compaction":
      endLine();
      console.log(`\n── context ${Math.round((100 * event.tokens) / event.contextWindow)}% full; summarizing older messages ──`);
      break;
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
      endLine();
      console.log(`→ ${event.name} ${event.arguments}`);
      break;
    case "tool_result":
      console.log(indent(event.isError ? `✗ ${event.output}` : preview(event.output)));
      break;
    case "delegation_start":
      endLine();
      console.log(`⇢ ${event.bot.name} takes over:\n${indent(preview(event.task, 4))}`);
      break;
    case "delegation_event":
      printDelegatedEvent(event.bot.name, event.event);
      break;
    case "delegation_end":
      console.log(`⇠ ${event.bot.name} ${{ done: "finished", step_limit: "ran out of steps", failed: "failed" }[event.status]}`);
      break;
  }
}

/** Only a delegated bot's tool use is shown; streaming its text would interleave with other bots working at once. */
function printDelegatedEvent(bot: string, event: AgentEvent): void {
  if (event.type === "tool_call") console.log(indent(`[${bot}] → ${event.name} ${event.arguments}`));
  if (event.type === "tool_result") console.log(indent(indent(event.isError ? `✗ ${event.output}` : preview(event.output, 4))));
}

function endLine(): void {
  if (streamingText) console.log();
  streamingText = false;
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
}).finally(closeDocuments);
