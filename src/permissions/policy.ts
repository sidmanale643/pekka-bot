export interface ToolPermission {
  effect: "read" | "write" | "command";
  plugin?: string;
  /**
   * Ask even when approval review is off. For changes that shape later runs, such as
   * instructions, skills and scheduled jobs, so text injected into one run can't persist.
   */
  confirm?: boolean;
}

export interface PermissionAction {
  tool: string;
  plugin?: string;
  reason: string;
  arguments: unknown;
}

export type ApproveAction = (action: PermissionAction) => Promise<boolean>;

const forbiddenCommands = [
  { pattern: /\b(?:rm|rmdir|shred|mkfs(?:\.\w+)?|wipefs|dd)\b/i, reason: "Deletion and disk operations are blocked, and you cannot delete files another way. Tell the user what should be removed." },
  { pattern: /\bgit\b[^\n]*(?:\breset\b[^\n]*--hard\b|\bclean\b|\bpush\b[^\n]*(?:--force\b|-f\b))/i, reason: "Destructive Git operations are blocked." },
  { pattern: /\b(?:sudo|su|chmod|chown|shutdown|reboot|poweroff)\b/i, reason: "Privilege, access and system control changes are blocked." },
  { pattern: /(?:curl|wget)\b[^\n]*\|[^\n]*\b(?:sh|bash|zsh)\b/i, reason: "Executing a downloaded script directly is blocked. Inspect it first." },
];

export function blockedCommand(command: string): string | undefined {
  return forbiddenCommands.find(({ pattern }) => pattern.test(command))?.reason;
}

const readOnlyOptions: Record<string, RegExp> = {
  pwd: /^-[LP]$/,
  whoami: /^(?:--help|--version)$/,
  ls: /^(?:-[aAbBcCdDfFgGhHiIklLmNnopqQrRsStTuUvwxX1]+|--(?:all|almost-all|directory|human-readable|numeric-uid-gid|recursive))$/,
  cat: /^(?:-[AbEnstTv]+|--(?:number|number-nonblank|squeeze-blank|show-all|show-ends|show-tabs|show-nonprinting))$/,
  head: /^(?:-[ncvq]|-\d+|--(?:lines|bytes)=\d+)$/,
  tail: /^(?:-[ncvq]|-\d+|--(?:lines|bytes)=\d+)$/,
  wc: /^(?:-[clmwL]+|--(?:bytes|chars|lines|words|max-line-length))$/,
  uname: /^(?:-[asnrvmpio]+|--all)$/,
};

export function isReadOnlyCommand(command: string): boolean {
  if (!/^[a-zA-Z0-9_./:@%+=, \t-]+$/.test(command)) return false;
  const [program, ...args] = command.trim().split(/\s+/);
  if (!Object.hasOwn(readOnlyOptions, program ?? "")) return false;
  const options = readOnlyOptions[program!]!;
  if (program === "pwd" || program === "whoami" || program === "uname") return args.every((arg) => options.test(arg));
  return args.every((arg) => arg === "--" || !arg.startsWith("-") || options.test(arg));
}

export async function authorizeAction(
  tool: string,
  permission: ToolPermission | undefined,
  input: unknown,
  approve?: ApproveAction,
): Promise<void> {
  if (permission?.effect === "read") return;
  if (permission?.effect === "command") {
    const command = (input as { command: string }).command;
    if (isReadOnlyCommand(command)) return;
    const blocked = blockedCommand(command);
    if (blocked) throw new Error(`Permission blocked: ${blocked} Do not bypass this gate with another tool or encoding.`);
  }
  // Every action that is not hard-blocked above runs without asking unless
  // approval review is turned on or the tool always confirms.
  if (!approvalRequired() && !permission?.confirm) return;
  const reason = permission?.plugin
    ? `This action changes ${permission.plugin} or sends information outside Pekka.`
    : permission?.confirm
      ? "This change is saved and shapes future runs, including scheduled ones."
      : "This action can change files, run code or alter state.";
  if (!approve) throw new Error(`Permission required for ${tool}. No interactive reviewer is available; the action was not executed. Report this limitation and do not retry or bypass it.`);
  const accepted = await approve({ tool, plugin: permission?.plugin, reason, arguments: structuredClone(input) });
  if (!accepted) throw new Error(`Permission denied for ${tool}. The action was not executed. Do not retry or bypass the user's decision.`);
}

/** Approval review is off by default; set PEKKA_REQUIRE_APPROVAL=true to ask before each action. */
export function approvalRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PEKKA_REQUIRE_APPROVAL === "true";
}
