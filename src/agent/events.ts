// What the loop reports while it works. The CLI prints these today;
// later the web UI will stream them and the database will store them.

import type { PermissionRequest } from "../permissions/manager.ts";

/** The bot the chief of staff handed work to. One delegation per bot runs at a time. */
export interface DelegatedBot {
  id: string;
  name: string;
}

export type AgentEvent =
  | { type: "permission_requested"; request: PermissionRequest }
  | { type: "permission_resolved"; id: string; approved: boolean }
  // The next prompt would fill half the context window, so older messages are being summarized.
  | { type: "compaction"; tokens: number; contextWindow: number }
  | { type: "step"; step: number }
  | { type: "message_delta"; text: string }
  | { type: "message"; text: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  // A delegated bot's run, reported live inside the chief of staff's run.
  | { type: "delegation_start"; bot: DelegatedBot; task: string }
  | { type: "delegation_event"; bot: DelegatedBot; event: AgentEvent }
  | { type: "delegation_end"; bot: DelegatedBot; status: "done" | "step_limit" | "failed"; answer: string };

export type EventHandler = (event: AgentEvent) => void;
