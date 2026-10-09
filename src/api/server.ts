import { characters, CharacterSchema, getCharacter, saveCharacter } from "../characters.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { AgentResult } from "../agent/loop.ts";
import type { EventHandler } from "../agent/events.ts";
import { BotMemory, memoryFiles } from "../bot-memory.ts";
import { deleteMessages, listMessages } from "../chat-history.ts";
import { ChatRecorder } from "../chat-recorder.ts";
import { createBot, deleteBot, updateBot, DuplicateBotError, ensureChiefOfStaff, findBot as findStoredBot, listBots, type Bot } from "../bots.ts";
import { loadConfig } from "../config.ts";
import { DatabaseConfigError } from "../database/d1.ts";
import { getDatabase, type Database } from "../database/database.ts";
import { createGreeting, type Greeting } from "../greeting.ts";
import { modelFor, ModelKeyError, ModelKeyService, NO_MODEL_KEY } from "../model-keys.ts";
import { deleteBotSandbox, executeTask, type Reserve, type RunOwner } from "../runtime.ts";
import {
  cancelScheduledJob, createScheduledJob, getScheduledJob, getSchedulerStatus, JobStateError, listScheduledJobs, pauseScheduledJob, resumeScheduledJob,
} from "../scheduler.ts";
import { SkillStore } from "../skills.ts";
import { loadAuthConfig, type AuthConfig } from "../auth.ts";
import { createAccess, type Access, type Route } from "./auth.ts";
import { body, fail, HttpError, json } from "./http.ts";
import { serveAsset } from "./static.ts";
import { modelKeyRoutes } from "./model-key.ts";
import { pluginRoutes } from "./plugins.ts";
import { getCalendarService, type CalendarService } from "../plugins/calendar.ts";
import { getContactsService, type ContactsService } from "../plugins/contacts.ts";
import { getDriveService, type DriveService } from "../plugins/drive.ts";
import { getGmailService, type GmailService } from "../plugins/gmail.ts";
import { GoogleError } from "../plugins/google.ts";
import { getGitHubService, GitHubError, type GitHubService } from "../plugins/github.ts";
import { WisprService, WisprError } from "../plugins/wispr.ts";
import { getLinearService, LinearError, type LinearService } from "../plugins/linear.ts";
import { ApiKeyPluginError } from "../plugins/api-key.ts";
import { createGranolaService, type GranolaService } from "../plugins/granola.ts";
import { TodoistError, createTodoistService, type TodoistService } from "../plugins/todoist.ts";
import { getNotionService, NotionError, type NotionService } from "../plugins/notion.ts";
import { getTelegramService, TelegramError, type TelegramService } from "../plugins/telegram.ts";
import { randomUUID } from "node:crypto";
import { PermissionManager } from "../permissions/manager.ts";

const text = z.string().trim().min(1).max(100_000);
const botInput = z.object({ name: text.max(200), role: text, job: z.string().trim().max(100_000), character: CharacterSchema.optional() }).strict();
const createBotInput = z.union([
  z.object({ name: text.max(200), description: text }).strict().transform(({ name, description }) => ({ name, role: description, job: "", character: undefined })),
  botInput,
]);
const conversationInput = z.array(z.object({ role: z.enum(["user", "assistant"]), content: text.max(4000) }).strict()).max(20);
const messageId = z.string().regex(/^[\w-]{1,100}$/);
// `chat` names the messages a bot's run is saved as, so the browser's live copy and the saved one match.
const runInput = z.object({
  task: text.optional(), botName: text.max(200).optional(), conversation: conversationInput.optional(), sessionId: text.max(150).optional(),
  chat: z.object({ question: messageId, reply: messageId }).strict().optional(),
}).strict()
  .refine((value) => value.task || value.botName, "Provide task or botName.");
const jobInput = z.object({
  name: text.max(200), task: text, runAt: z.iso.datetime({ offset: true }),
  intervalSeconds: z.number().int().min(60).max(31_536_000).optional(), botName: text.max(200).optional(),
}).strict();

/**
 * In the public shared workspace, one visitor's connected accounts and model keys would be
 * every visitor's, so it lists no plugins and refuses to connect one or save a key.
 */
const offInPublicWorkspace = (feature: string, pattern: RegExp) => ["GET", "POST", "PUT", "DELETE"].map((method): Route => [method, pattern, async () => {
  throw new HttpError(403, `${feature} are off in the public shared workspace.`);
}]);
const publicWorkspaceRoutes: Route[] = [
  ["GET", /^\/api\/plugins$/, async (_request, response) => { json(response, 200, { plugins: [] }); }],
  ...offInPublicWorkspace("Plugins", /^\/api\/plugins\/.+$/),
  ...offInPublicWorkspace("Saved model keys", /^\/api\/model-keys(?:\/.*)?$/),
];

type Execute = (task: string, owner: RunOwner, onEvent?: EventHandler) => Promise<AgentResult>;
type Greet = (bot: Bot, userId: string) => Promise<Greeting>;
type DeleteSandbox = (userId: string, bot: Bot) => Promise<void>;
type Handler = Route[2];

interface ServerOptions {
  execute?: Execute;
  greet?: Greet;
  deleteSandbox?: DeleteSandbox;
  database?: Database;
  notion?: NotionService;
  telegram?: TelegramService;
  gmail?: GmailService;
  calendar?: CalendarService;
  drive?: DriveService;
  contacts?: ContactsService;
  github?: GitHubService;
  wispr?: WisprService;
  linear?: LinearService;
  granola?: GranolaService;
  todoist?: TodoistService;
  modelKeys?: ModelKeyService;
  /** Sign-in settings. Defaults to the environment; null turns sign-in off. */
  auth?: AuthConfig | null;
  publicOrigin?: string;
  /** Used to reach Google during sign-in. */
  fetch?: typeof fetch;
}

export function createApiServer(options: ServerOptions = {}) {
  const execute = options.execute ?? executeTask;
  const database = () => options.database ?? getDatabase();
  const access = createAccess(options.auth === undefined ? loadAuthConfig() : options.auth ?? undefined, database, { fetch: options.fetch, publicOrigin: options.publicOrigin });
  const shared = Boolean(options.publicOrigin);
  const modelKeys = options.modelKeys ?? new ModelKeyService({ database });
  const greet: Greet = options.greet ?? (async (bot, userId) => {
    let config;
    try { config = loadConfig(); } catch { throw new HttpError(503, "Greetings require valid provider configuration."); }
    return createGreeting(bot, (await modelFor(userId, config, modelKeys)).model, database());
  });
  const deleteSandbox: DeleteSandbox = options.deleteSandbox ?? ((userId, bot) => {
    try { loadConfig(); } catch { throw new HttpError(503, "Deleting a bot's sandbox requires valid provider configuration."); }
    return deleteBotSandbox(userId, bot);
  });
  const active = new Set<string>();
  const cancellations = new Map<string, { controller: AbortController; runId: string }>();
  const permissions = new PermissionManager();
  /** The chief of staff's delegations take the other bot's workspace, so it can't also run from the web interface. */
  const reserve: Reserve = (bot) => {
    const key = `bot:${bot.id}`;
    if (active.has(key)) return undefined;
    active.add(key);
    return () => active.delete(key);
  };

  /** Another user's bot is reported as missing, the same as one that doesn't exist. */
  async function findBot(userId: string, name: string): Promise<Bot> {
    const bot = await findStoredBot(userId, name, database());
    if (!bot) throw new HttpError(404, "Bot not found.");
    return bot;
  }

  const create: Handler = async (request, response, _params, userId) => {
    const { character, ...input } = await body(request, createBotInput);
    try {
      const bot = await createBot(userId, input, database());
      if (character) await saveCharacter(bot.id, character, database());
      json(response, 201, bot);
    } catch (error) {
      if (error instanceof DuplicateBotError) throw new HttpError(409, "Bot already exists.");
      throw error;
    }
  };

  const run: Handler = async (request, response, _params, userId) => {
    const input = await body(request, runInput);
    const bot = input.botName ? await findBot(userId, input.botName) : undefined;
    // One run at a time per sandbox: each bot has its own, and each user has one for unnamed runs.
    const key = bot ? `bot:${bot.id}` : `user:${userId}`;
    if (active.has(key)) throw new HttpError(409, "A task is already running in this workspace.");
    if (!options.execute) {
      let config;
      try { config = loadConfig(); } catch { throw new HttpError(503, "Task execution requires valid provider configuration."); }
      // Checked before the run starts streaming, because after that an error only reaches the browser as "Task execution failed."
      if (!config.openRouterApiKey && !(await modelKeys.choice(userId))) throw new HttpError(503, NO_MODEL_KEY);
    }
    const task = input.task ?? bot?.job;
    if (!task) throw new HttpError(400, "Send a message to tell this bot what you need.");
    active.add(key);
    const runId = randomUUID();
    const controller = new AbortController();
    cancellations.set(key, { controller, runId });
    let recorder: ChatRecorder | undefined;
    const emit: EventHandler = (event) => {
      const streamed = recorder ? recorder.apply(event) : event;
      if (!response.destroyed && response.headersSent) response.write(`event: ${streamed.type}\ndata: ${JSON.stringify(streamed)}\n\n`);
    };
    const streaming = request.headers.accept?.includes("text/event-stream");
    const review = permissions.reviewer(userId, runId,
      (request) => emit({ type: "permission_requested", request }),
      (id, approved) => emit({ type: "permission_resolved", id, approved }));
    // The run carries on if the browser that started it disconnects, so its approval requests stay open for any
    // tab to answer until they expire or the run is stopped.
    const approveAction = streaming ? review : undefined;
    try {
      // A bot's chat is saved here as the run goes, so it's kept even if the browser that asked disconnects.
      if (bot) recorder = await ChatRecorder.start({ userId, botId: bot.id, botName: bot.name, database }, task, input.chat);
      await respondToRun(request, response, async () => {
        try {
          const result = await execute(task, { userId, bot, approveAction, conversation: input.conversation, signal: controller.signal, sessionId: input.sessionId ? `${userId}:${input.sessionId}` : undefined, reserve: (target) => {
            const release = reserve(target);
            if (!release) return undefined;
            const targetKey = `bot:${target.id}`;
            cancellations.set(targetKey, { controller, runId });
            return () => { cancellations.delete(targetKey); release(); };
          } }, emit).catch((error) => {
            if (!controller.signal.aborted) throw error;
            return { status: "stopped" as const, answer: "", steps: 0, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 }, messages: [] };
          });
          await recorder?.finish(result);
          return result;
        } catch (error) {
          await recorder?.fail("Task execution failed.");
          throw error;
        }
      });
    } finally {
      permissions.cancelRun(runId);
      cancellations.delete(key);
      active.delete(key);
    }
  };

  async function idleBot(userId: string, name: string) {
    const bot = await findBot(userId, name);
    const scheduled = (await listScheduledJobs(userId, database())).filter((job) => job.bot?.id === bot.id);
    if (active.has(`bot:${bot.id}`) || scheduled.some((job) => job.status === "running")) throw new HttpError(409, "Wait for this bot's running task to finish before editing or deleting it.");
    return { bot, scheduled };
  }

  const removeBot: Handler = async (_request, response, [name], userId) => {
    const { bot, scheduled } = await idleBot(userId, name!);
    if (bot.primary) throw new HttpError(409, "The chief of staff can't be deleted. Rename it or change its purpose instead.");
    // The sandbox goes first, so a failure leaves the bot in place to try again rather than an orphaned sandbox.
    try { await deleteSandbox(userId, bot); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `Could not delete ${bot.name}'s sandbox, so the bot was kept. ${error instanceof Error ? `${error.message} ` : ""}Try again.`);
    }
    for (const job of scheduled.filter((job) => job.status === "pending" || job.status === "paused")) await cancelScheduledJob(userId, job.id, database());
    await deleteBot(userId, bot.id, database());
    json(response, 200, { deleted: true });
  };

  const editBot: Handler = async (request, response, [name], userId) => {
    const { bot } = await idleBot(userId, name!);
    const input = await body(request, botInput.omit({ character: true }));
    try { json(response, 200, await updateBot(userId, bot.id, input, database())); }
    catch (error) {
      if (error instanceof DuplicateBotError) throw new HttpError(409, error.message);
      throw error;
    }
  };

  const memory: Handler = async (request, response, [name, file], userId) => {
    const bot = await findBot(userId, name!);
    const memoryFile = z.enum(memoryFiles).parse(file);
    const store = new BotMemory(bot, database());
    if (request.method === "PUT") {
      const input = await body(request, z.object({ content: z.string().max(900_000) }).strict());
      await store.write(memoryFile, input.content);
    }
    json(response, 200, { file: memoryFile, content: await store.read(memoryFile) });
  };

  const chat: Handler = async (request, response, [name], userId) => {
    const bot = await findBot(userId, name!);
    if (request.method === "GET") {
      json(response, 200, { messages: await listMessages(userId, bot.id, database()) });
      return;
    }
    // A running reply keeps saving into the chat, so clearing now would leave half a conversation.
    if (active.has(`bot:${bot.id}`)) throw new HttpError(409, "Wait for this bot's running task to finish before clearing its chat.");
    await deleteMessages(userId, bot.id, database());
    json(response, 200, { cleared: true });
  };

  const schedule: Handler = async (request, response, _params, userId) => {
    const { botName, ...input } = await body(request, jobInput);
    const bot = botName ? await findBot(userId, botName) : undefined;
    if (Date.parse(input.runAt) <= Date.now()) throw new HttpError(400, "runAt must be in the future.");
    // Visitors would leave jobs running on the server's keys after they've gone.
    if (shared) throw new HttpError(403, "Scheduled jobs are off in the public shared workspace.");
    try {
      json(response, 201, await createScheduledJob(userId, { ...input, bot }, database()));
    } catch (error) {
      if (error instanceof JobStateError) throw new HttpError(409, error.message);
      throw error;
    }
  };

  const jobActions = { cancel: cancelScheduledJob, pause: pauseScheduledJob, resume: resumeScheduledJob };
  const job: Handler = async (_request, response, [id, action], userId) => {
    const existing = await getScheduledJob(userId, id!, database());
    if (!existing) throw new HttpError(404, "Scheduled job not found.");
    if (!action) { json(response, 200, existing); return; }
    try {
      json(response, 200, await jobActions[action as keyof typeof jobActions](userId, id!, database()));
    } catch (error) {
      if (error instanceof JobStateError) throw new HttpError(409, error.message);
      throw error;
    }
  };

  const character: Handler = async (request, response, [name], userId) => {
    const bot = await findBot(userId, name!);
    const value = request.method === "PUT"
      ? await saveCharacter(bot.id, await body(request, CharacterSchema), database())
      : await getCharacter(bot.id, database());
    json(response, 200, value);
  };

  const routes: Route[] = [
    ["POST", /^\/api\/bots\/([^/]+)\/stop$/, async (_request, response, [name], userId) => {
      const bot = await findBot(userId, name!);
      const run = cancellations.get(`bot:${bot.id}`);
      if (run) {
        run.controller.abort();
        permissions.cancelRun(run.runId);
      }
      json(response, 200, { stopping: Boolean(run) });
    }],
    ["GET", /^\/api\/permissions$/, async (_request, response, _params, userId) => {
      json(response, 200, { requests: permissions.list(userId) });
    }],
    ["POST", /^\/api\/permissions\/([^/]+)$/, async (request, response, [id], userId) => {
      const { approved } = await body(request, z.object({ approved: z.boolean() }).strict());
      if (!permissions.decide(userId, id!, approved)) throw new HttpError(404, "Permission request is missing or expired.");
      json(response, 200, { approved });
    }],
    ...access.routes,
    ...(shared ? publicWorkspaceRoutes : [
      ...pluginRoutes({
        notion: options.notion ?? getNotionService(), gmail: options.gmail ?? getGmailService(), calendar: options.calendar ?? getCalendarService(),
        drive: options.drive ?? getDriveService(), contacts: options.contacts ?? getContactsService(),
        telegram: options.telegram ?? getTelegramService(), github: options.github ?? getGitHubService(), linear: options.linear ?? getLinearService(), wispr: options.wispr ?? new WisprService({ database }),
        granola: options.granola ?? createGranolaService({ database }), todoist: options.todoist ?? createTodoistService({ database }),
      }, access.origin),
      ...modelKeyRoutes(modelKeys, () => { try { const config = loadConfig(); return { model: config.model, key: Boolean(config.openRouterApiKey) }; } catch { return undefined; } }),
    ]),
    ["GET", /^\/api\/characters$/, async (_request, response) => { json(response, 200, { characters: characters.map(({ style, ...item }) => item) }); }],
    ["GET", /^\/api\/bots\/([^/]+)\/character$/, character],
    ["PUT", /^\/api\/bots\/([^/]+)\/character$/, character],
    ["GET", /^\/api\/health$/, async (_request, response) => { json(response, 200, { status: "ok" }); }, true],
    ["GET", /^\/api\/bots$/, async (_request, response, _params, userId) => {
      await ensureChiefOfStaff(userId, database());
      json(response, 200, { bots: await listBots(userId, database()) });
    }],
    ["POST", /^\/api\/bots$/, create],
    ["GET", /^\/api\/bots\/([^/]+)$/, async (_request, response, [name], userId) => { json(response, 200, await findBot(userId, name!)); }],
    ["PUT", /^\/api\/bots\/([^/]+)$/, editBot],
    ["DELETE", /^\/api\/bots\/([^/]+)$/, removeBot],
    ["POST", /^\/api\/runs$/, run],
    ["GET", /^\/api\/bots\/([^/]+)\/greeting$/, async (_request, response, [name], userId) => { json(response, 200, await greet(await findBot(userId, name!), userId)); }],
    ["GET", /^\/api\/bots\/([^/]+)\/messages$/, chat],
    ["DELETE", /^\/api\/bots\/([^/]+)\/messages$/, chat],
    ["GET", /^\/api\/bots\/([^/]+)\/memory\/([^/]+)$/, memory],
    ["PUT", /^\/api\/bots\/([^/]+)\/memory\/([^/]+)$/, memory],
    ["GET", /^\/api\/bots\/([^/]+)\/skills$/, async (_request, response, [name], userId) => {
      json(response, 200, await new SkillStore(await findBot(userId, name!), database()).catalog());
    }],
    ["GET", /^\/api\/skills$/, async (_request, response) => { json(response, 200, await new SkillStore(undefined, database()).catalog()); }],
    ["GET", /^\/api\/jobs$/, async (_request, response, _params, userId) => {
      const [jobs, scheduler] = await Promise.all([listScheduledJobs(userId, database()), getSchedulerStatus(database())]);
      json(response, 200, { jobs, scheduler });
    }],
    ["POST", /^\/api\/jobs$/, schedule],
    ["GET", /^\/api\/jobs\/([^/]+)$/, job],
    ["POST", /^\/api\/jobs\/([^/]+)\/(cancel|pause|resume)$/, job],
  ];

  return createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    dispatch(request, response, routes, access).catch((error: unknown) => {
      if (error instanceof NotionError || error instanceof GoogleError || error instanceof TelegramError || error instanceof GitHubError || error instanceof LinearError || error instanceof WisprError || error instanceof TodoistError || error instanceof ApiKeyPluginError || error instanceof ModelKeyError) { fail(response, new HttpError(400, error.message)); return; }
      fail(response, error instanceof DatabaseConfigError ? new HttpError(503, error.message) : error);
    });
  });
}

async function respondToRun(request: IncomingMessage, response: ServerResponse, execute: () => Promise<AgentResult>): Promise<void> {
  const stream = request.headers.accept?.includes("text/event-stream");
  if (stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    response.flushHeaders();
  }
  const { messages: _messages, ...result } = await execute();
  if (response.destroyed) return;
  if (stream) {
    response.end(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
    return;
  }
  json(response, 200, result);
}

async function dispatch(request: IncomingMessage, response: ServerResponse, routes: Route[], access: Access): Promise<void> {
  access.check(request);
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (await serveAsset(request, response, pathname)) return;
  const matches = routes.filter(([, pattern]) => pattern.test(pathname));
  if (!matches.length) throw new HttpError(404, "Route not found.");
  const route = matches.find(([method]) => method === request.method);
  if (!route) {
    response.setHeader("Allow", [...new Set(matches.map(([method]) => method))].join(", "));
    throw new HttpError(405, "Method not allowed.");
  }
  let params: string[];
  try { params = route[1].exec(pathname)!.slice(1).map(decodeURIComponent); }
  catch { throw new HttpError(400, "Invalid URL encoding."); }
  // Public routes run without a user. Everything else needs one, and only sees that user's data.
  const userId = route[3] ? "" : await access.userId(request);
  await route[2](request, response, params, userId);
}
