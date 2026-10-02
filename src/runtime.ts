import type { EventHandler } from "./agent/events.ts";
import { runAgent, type ConversationMessage } from "./agent/loop.ts";
import { findBotById, type Bot } from "./bots.ts";
import { openDaytonaComputer } from "./computer/daytona-computer.ts";
import { loadConfig, type Config } from "./config.ts";
import { LOCAL_USER } from "./database/database.ts";
import { createOpenRouterModel, fetchContextWindow } from "./model/openrouter.ts";
import { chiefTools, defaultTools, unnamedTools } from "./tools/index.ts";
import type { Delegate } from "./tools/tool.ts";
import type { ApproveAction } from "./permissions/policy.ts";

/** Marks a bot's workspace busy and returns how to release it, or undefined if it is already busy. */
export type Reserve = (bot: Bot) => (() => void) | undefined;

/** Who a run is for, and which of their bots runs it. Unnamed runs have no bot. */
export interface RunOwner {
  userId: string;
  bot?: Bot;
  approveAction?: ApproveAction;
  conversation?: ConversationMessage[];
  /** Claims a bot's workspace while the chief of staff delegates to it. Defaults to tracking delegations in this process. */
  reserve?: Reserve;
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
  const sandboxName = sandboxNameFor(config, owner);
  const { computer, release } = openDaytonaComputer({ apiKey: config.daytonaApiKey, sandboxName, workspace: Boolean(owner.bot) });
  try {
    const model = createOpenRouterModel({ apiKey: config.openRouterApiKey, model: config.model });
    const contextWindow = config.contextWindow ?? await fetchContextWindow(config.model);
    const chief = owner.bot?.primary === true;
    return await runAgent(task, {
      model, computer, tools: chief ? chiefTools : owner.bot ? defaultTools : unnamedTools, maxSteps: config.maxSteps, contextWindow, userId: owner.userId, bot: owner.bot,
      approveAction: owner.approveAction, conversation: owner.conversation, delegate: chief ? delegateFor(owner, onEvent) : undefined, onEvent,
    });
  } finally {
    // Not awaited, so the answer isn't held up while the sandbox stops.
    release().catch((error) => console.error(`Could not stop sandbox "${sandboxName}": ${error instanceof Error ? error.message : error}`));
  }
}

const delegating = new Set<string>();
const reserveInProcess: Reserve = (bot) => {
  if (delegating.has(bot.id)) return undefined;
  delegating.add(bot.id);
  return () => delegating.delete(bot.id);
};

/**
 * The chief of staff's delegations run as the other bot, in its own sandbox
 * and with its own tools. Approvals go to the same reviewer as the chief's,
 * and the bot's events are reported live through the chief's `onEvent`.
 */
export function delegateFor({ userId, approveAction, reserve = reserveInProcess }: RunOwner, onEvent?: EventHandler, execute = executeTask): Delegate {
  const emit: EventHandler = onEvent ?? (() => {});
  return async (bot, task) => {
    const release = reserve(bot);
    if (!release) throw new Error(`${bot.name} is busy with another task. Try again after it finishes.`);
    const delegated = { id: bot.id, name: bot.name };
    emit({ type: "delegation_start", bot: delegated, task });
    try {
      const { messages: _messages, ...result } = await execute(task, { userId, bot, approveAction }, (event) => emit({ type: "delegation_event", bot: delegated, event }));
      emit({ type: "delegation_end", bot: delegated, status: result.status, answer: result.answer });
      return result;
    } catch (error) {
      // The reason reaches the chief as the tool's error; the live view only needs to know it ended.
      emit({ type: "delegation_end", bot: delegated, status: "failed", answer: "" });
      throw error;
    } finally {
      release();
    }
  };
}
