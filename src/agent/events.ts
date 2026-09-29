// What the loop reports while it works. The CLI prints these today;
// later the web UI will stream them and the database will store them.

export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "message_delta"; text: string }
  | { type: "message"; text: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; output: string; isError: boolean };

export type EventHandler = (event: AgentEvent) => void;
