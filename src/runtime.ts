import type { EventHandler } from "./agent/events.ts";
import { runAgent } from "./agent/loop.ts";
import { findBotById, type Bot } from "./bots.ts";
import { connectDaytonaComputer } from "./computer/daytona-computer.ts";
import { loadConfig, type Config } from "./config.ts";
import { LOCAL_USER } from "./database/database.ts";
import { createOpenRouterModel } from "./model/openrouter.ts";
import { defaultTools } from "./tools/index.ts";
import type { ApproveAction } from "./permissions/policy.ts";

/** Who a run is for, and which of their bots runs it. Unnamed runs have no bot. */
export interface RunOwner {
  userId: string;
  bot?: Bot;
  approveAction?: ApproveAction;
}

/**
 * Each named bot has its own sandbox, named after its stable ID. Unnamed runs
 * use the configured sandbox for the local user and a separate one for everyone else.
 */
export function sandboxNameFor(config: Config, { userId, bot }: RunOwner): string {
  if (bot) return `${config.sandboxName.slice(0, 30)}-bot-${bot.id}`;
  return userId === LOCAL_USER ? config.sandboxName : `${config.sandboxName.slice(0, 30)}-user-${userId}`;
}

export async function executeTask(task: string, owner: RunOwner, onEvent?: EventHandler) {
  if (owner.bot) {
    const bot = await findBotById(owner.userId, owner.bot.id);
    if (!bot) throw new Error("This bot was deleted. Its task cannot run.");
    owner = { ...owner, bot };
  }
  const config = loadConfig();
  const computer = await connectDaytonaComputer({
    apiKey: config.daytonaApiKey,
    sandboxName: sandboxNameFor(config, owner),
    workspace: Boolean(owner.bot),
  });
  const model = createOpenRouterModel({ apiKey: config.openRouterApiKey, model: config.model });
  return runAgent(task, { model, computer, tools: defaultTools, maxSteps: config.maxSteps, userId: owner.userId, bot: owner.bot, approveAction: owner.approveAction, onEvent });
}
