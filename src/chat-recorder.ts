import { randomUUID } from "node:crypto";
import type { AgentEvent } from "./agent/events.ts";
import type { AgentResult } from "./agent/loop.ts";
import { saveMessages, type ChatMessage } from "./chat-history.ts";
import type { Database } from "./database/database.ts";

/** A card under an answer for something a write tool made or changed, linking to it when it can. */
export interface ToolCard {
  plugin: string;
  title: string;
  detail: string;
  url?: string;
  /** The bot a delegate_task card opens the handoff of. */
  bot?: string;
}

// Write tools whose results become cards under the answer and in the bot panel.
const TOOL_CARDS: Record<string, [plugin: string, done: string]> = {
  notion_create_page: ["Notion", "Created page"],
  notion_append_text: ["Notion", "Added to page"],
  github_create_issue: ["GitHub", "Opened issue"],
  github_create_pull_request: ["GitHub", "Opened pull request"],
  github_add_comment: ["GitHub", "Commented"],
  linear_create_issue: ["Linear", "Created issue"],
  linear_update_issue: ["Linear", "Updated issue"],
  linear_add_comment: ["Linear", "Commented"],
  todoist_create_task: ["Todoist", "Added task"],
  todoist_update_task: ["Todoist", "Updated task"],
  todoist_complete_task: ["Todoist", "Completed task"],
  todoist_reopen_task: ["Todoist", "Reopened task"],
  todoist_add_comment: ["Todoist", "Commented"],
  gmail_send: ["Gmail", "Sent email"],
  gmail_create_draft: ["Gmail", "Saved draft"],
  calendar_create_event: ["Calendar", "Created event"],
  calendar_update_event: ["Calendar", "Updated event"],
  calendar_respond_to_event: ["Calendar", "Answered invitation"],
  calendar_delete_event: ["Calendar", "Deleted event"],
  tasks_create: ["Tasks", "Added reminder"],
  tasks_update: ["Tasks", "Updated task"],
  docs_create: ["Docs", "Created document"],
  docs_append_text: ["Docs", "Added to document"],
  sheets_create: ["Sheets", "Created spreadsheet"],
  sheets_append_rows: ["Sheets", "Added rows"],
  sheets_update_range: ["Sheets", "Updated cells"],
  send_email: ["Email", "Sent email"],
  telegram_send_message: ["Telegram", "Sent message"],
  schedule_job: ["Scheduled", "Scheduled task"],
  create_bot: ["Team", "Created bot"],
  delegate_task: ["Team", "Delegated task"],
  write_file: ["Sandbox", "Saved file"],
  write_skill: ["Skills", "Saved skill"],
};

const parse = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch { return {}; }
};
const string = (value: unknown) => typeof value === "string" ? value : "";

/** The card for a write tool's result, keeping only what the card shows. */
export function toolCard(name: string, args: string, output: string): ToolCard | undefined {
  const kind = TOOL_CARDS[name];
  if (!kind) return undefined;
  const input = parse(args);
  const result = parse(output) as Record<string, Record<string, Record<string, unknown> | undefined> | undefined>;
  // Linear nests what a write created or changed under the mutation's name.
  const linear = result.issueCreate?.issue ?? result.issueUpdate?.issue ?? result.commentCreate?.comment;
  const url = [result.html_url, result.url, linear?.url].map(string).find((value) => /^https:\/\//.test(value));
  const repository = input.owner && input.repo ? `${string(input.owner)}/${string(input.repo)}` : "";
  const title = [input.title, input.subject, input.name, input.bot_name, input.path, input.issue].map(string).find(Boolean)
    || (input.issue_number ? `${repository}#${String(input.issue_number)}` : "")
    || string(input.text).slice(0, 80)
    || string(input.content).slice(0, 80)
    || kind[1];
  const detail = [kind[1], repository && !title.startsWith(repository) ? repository : "", [input.to].flat().filter((to) => typeof to === "string" && to).join(", ")]
    .filter(Boolean)
    .join(" · ");
  return { plugin: kind[0], title, detail, ...(url ? { url } : {}), ...(name === "delegate_task" && string(input.bot_name) ? { bot: string(input.bot_name) } : {}) };
}

type ToolResult = Extract<AgentEvent, { type: "tool_result" }>;
type DelegationStart = Extract<AgentEvent, { type: "delegation_start" }>;
type DelegationEvent = Extract<AgentEvent, { type: "delegation_event" }>;
/** A run event as the browser receives it: a tool result carries its card, and a delegation the IDs of the messages it saves. */
export type StreamedEvent =
  | Exclude<AgentEvent, ToolResult | DelegationStart | DelegationEvent>
  | ToolResult & { card?: ToolCard }
  | DelegationStart & { messages?: { question: string; reply: string } }
  | Omit<DelegationEvent, "event"> & { event: StreamedEvent };

type Step = { name: string; isError?: boolean; output?: ToolCard };
type Reply = ChatMessage & { pending: boolean; status: string; tools?: Step[]; permissions?: Record<string, unknown>[]; usage?: AgentResult["usage"] };

const delegationEndings = { stopped: "Stopped", done: "", step_limit: "Ran out of steps before finishing", failed: "Failed" } as const;
/** Saves of a running reply are spaced at least this far apart. Its question and its final state are saved right away. */
const SAVE_INTERVAL_MS = 1000;

type Target = { userId: string; botId: string; botName: string; database: () => Database };

/**
 * Builds a bot's reply from its run's events and saves it, with the message that asked for it, in the bot's chat.
 * The chat is saved on the server as the run goes, so it doesn't depend on the browser that started it staying connected.
 */
export class ChatRecorder {
  readonly question: ChatMessage;
  private readonly reply: Reply;
  private readonly calls = new Map<string, { step: Step; args: string }>(); // tool call ID → its step and arguments
  private readonly running = new Map<string, ChatRecorder>(); // bot ID → the recorder of the reply it's running for a delegation
  private readonly delegated: ChatRecorder[] = [];
  private newText = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();

  private constructor(private readonly target: Target, text: string, from?: string, ids?: { question: string; reply: string }) {
    // The question and its reply share a time, so sorting by time keeps the question first.
    const time = Date.now();
    this.question = { id: ids?.question ?? randomUUID(), time, role: "user", text, ...(from ? { from } : {}) };
    this.reply = { id: ids?.reply ?? randomUUID(), time, role: "assistant", text: "", pending: true, status: "" };
  }

  /**
   * Saves `text` as a message to the bot and its reply as pending, then records the reply.
   * `ids` are the browser's, so its live copy and the saved one are the same messages. Throws if the chat can't be saved.
   */
  static async start(target: Target, text: string, ids?: { question: string; reply: string }): Promise<ChatRecorder> {
    const recorder = new ChatRecorder(target, text, undefined, ids);
    await saveMessages(target.userId, target.botId, [recorder.question, structuredClone(recorder.reply)], target.database());
    return recorder;
  }

  /** Applies a run event to the reply and returns the event to stream. */
  apply(event: AgentEvent): StreamedEvent {
    const streamed = this.update(event);
    if (event.type !== "compaction") this.schedule();
    return streamed;
  }

  private update(event: AgentEvent): StreamedEvent {
    const reply = this.reply;
    switch (event.type) {
      case "permission_requested":
        (reply.permissions ??= []).push({ ...event.request });
        return event;
      case "permission_resolved": {
        const request = reply.permissions?.find((item) => item.id === event.id);
        if (request) request.decision = event.approved ? "Approved once" : "Denied or expired";
        return event;
      }
      case "step":
        // Each step's text replaces the last one's when it starts streaming.
        this.newText = true;
        return event;
      case "message_delta":
        if (this.newText) reply.text = "";
        this.newText = false;
        reply.text += event.text;
        return event;
      case "message":
        reply.text = event.text;
        return event;
      case "tool_call": {
        const step: Step = { name: event.name };
        (reply.tools ??= []).push(step);
        this.calls.set(event.id, { step, args: event.arguments });
        return event;
      }
      case "tool_result": {
        const call = this.calls.get(event.id);
        if (!call) return event;
        this.calls.delete(event.id);
        call.step.isError = event.isError;
        const card = event.isError ? undefined : toolCard(event.name, call.args, event.output);
        if (!card) return event;
        call.step.output = card;
        return { ...event, card };
      }
      case "delegation_start": {
        // The brief shows in the other bot's chat as coming from this bot.
        const recorder = new ChatRecorder({ ...this.target, botId: event.bot.id, botName: event.bot.name }, event.task, this.target.botName);
        recorder.save([recorder.question, structuredClone(recorder.reply)]);
        this.running.set(event.bot.id, recorder);
        this.delegated.push(recorder);
        return { ...event, messages: { question: recorder.question.id, reply: recorder.reply.id } };
      }
      case "delegation_event": {
        const recorder = this.running.get(event.bot.id);
        return { ...event, event: recorder ? recorder.apply(event.event) : event.event };
      }
      case "delegation_end": {
        const recorder = this.running.get(event.bot.id);
        this.running.delete(event.bot.id);
        recorder?.end(event.answer || recorder.reply.text, delegationEndings[event.status]);
        return event;
      }
      default:
        return event;
    }
  }

  /** Saves the reply as the run finished, once every earlier save of it and of the replies it delegated is done. */
  async finish(result: Pick<AgentResult, "status" | "answer" | "usage">): Promise<void> {
    this.reply.usage = result.usage;
    this.end(
      result.answer || this.reply.text || (result.status === "stopped" ? "" : "Task finished without a text response."),
      result.status === "done" ? "" : result.status === "stopped" ? "Stopped" : `Run ended: ${result.status}`,
    );
    await this.settled();
  }

  /** Saves the reply as failed, keeping what it had written before the error. */
  async fail(message: string): Promise<void> {
    this.reply.role = "error";
    this.end([this.reply.text, message].filter(Boolean).join("\n\n"), "");
    await this.settled();
  }

  private end(text: string, status: string) {
    for (const recorder of this.running.values()) recorder.end(recorder.reply.text, delegationEndings.failed);
    this.running.clear();
    // A call that never reported back didn't finish.
    for (const { step } of this.calls.values()) step.isError ??= true;
    this.calls.clear();
    Object.assign(this.reply, { text, status, pending: false });
    clearTimeout(this.timer);
    this.timer = undefined;
    this.save([structuredClone(this.reply)]);
  }

  private async settled() {
    await Promise.all([this, ...this.delegated].map((recorder) => recorder.saving));
  }

  private schedule() {
    if (this.timer || !this.reply.pending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.reply.pending) this.save([structuredClone(this.reply)]);
    }, SAVE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Queues a save after the ones before it, so a reply's states reach the database in order. A failed save is logged, not thrown. */
  private save(messages: ChatMessage[]) {
    const { userId, botId, database } = this.target;
    this.saving = this.saving
      .then(() => saveMessages(userId, botId, messages, database()))
      .catch((error: unknown) => { console.error(`Could not save a chat message: ${error instanceof Error ? error.message : String(error)}`); });
  }
}
