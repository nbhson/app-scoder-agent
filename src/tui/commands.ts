/**
 * Slash commands shared by the classic REPL (src/index.ts) and the Ink TUI
 * (src/tui/app.tsx). Pure parsing/formatting only — each frontend executes
 * the command against its own context, so both stay in sync on the surface.
 */

export interface SlashCommand {
  /** Canonical name including the leading slash, e.g. "/help". */
  cmd: string;
  /** Free-form argument ("" when absent). */
  arg: string;
}

export const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/help", desc: "show this command list" },
  { cmd: "/clear", desc: "clear the conversation and reset agent context" },
  { cmd: "/cost", desc: "token usage of the current session" },
  { cmd: "/model", desc: "show the active model & provider" },
  { cmd: "/skills", desc: "list discovered skills (SKILL.md)" },
  { cmd: "/skill", desc: "load a skill into context: /skill <name>" },
  { cmd: "/mcp", desc: "MCP servers & tools: /mcp [server] [tool] [json]" },
  { cmd: "/permission", desc: "view or switch permission mode: /permission <auto|ask|readonly>" },
  { cmd: "/exit", desc: "quit (aliases: /quit, exit, quit)" },
];

/** Parse "/cmd arg…"; returns null when the input is not a slash command. */
export function parseSlashCommand(input: string): SlashCommand | null {
  const m = /^\/([a-zA-Z][a-zA-Z0-9]*)(?:\s+(.*\S))?\s*$/.exec(input.trim());
  if (!m) return null;
  return { cmd: "/" + m[1].toLowerCase(), arg: m[2] ?? "" };
}

/**
 * Tab completion for a partial input starting with "/".
 * Returns the completed command (with trailing space) plus all candidates,
 * or null when the input is not completable.
 */
export function completeSlashCommand(
  input: string,
): { completed: string; candidates: Array<{ cmd: string; desc: string }> } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const partial = trimmed.toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(partial) && partial.length >= 1);
  if (matches.length === 0) return null;
  // Exact match — complete to it (e.g. typing "/help" + Tab still completes).
  if (matches.length === 1) return { completed: matches[0].cmd + " ", candidates: matches };
  // Common prefix of all matches (e.g. "/sk" → "/skill" prefix of /skills+/skill).
  let prefix = matches[0].cmd;
  for (const m of matches.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < m.cmd.length && prefix[i] === m.cmd[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return { completed: prefix + (matches.length === 1 ? " " : ""), candidates: matches };
}

/** Format the /help listing (shared so both frontends render identically). */
export function formatSlashHelp(commandName: string): string {
  const rows = SLASH_COMMANDS.map((c) => `  ${c.cmd.padEnd(12)} ${c.desc}`).join("\n");
  return `Commands (${commandName}):\n${rows}\n  Anything else is sent to the agent as a task.\n  Tab completes commands; ↑/↓ recalls history.`;
}

/**
 * Parse a `/mcp` exec invocation into (fullName, args).
 *
 * Forms:
 *   /mcp                                  → list (no exec)
 *   /mcp server tool {"k":"v"}            → mcp__server__tool
 *   /mcp mcp__server__tool {"k":"v"}      → as-is (full name)
 * The JSON part is optional (tools with no args); bad JSON → error message.
 */
export function parseMcpExec(arg: string): { fullName: string; args: Record<string, unknown> } | { error: string } | null {
  const trimmed = arg.trim();
  if (!trimmed) return null; // list mode
  const tokens = trimmed.split(/\s+/);
  let fullName: string;
  let rest: string;
  if (tokens[0].startsWith("mcp__")) {
    fullName = tokens[0];
    rest = trimmed.slice(tokens[0].length).trim();
  } else {
    if (tokens.length < 2) return { error: "usage: /mcp <server> <tool> [json-args] — list servers with bare /mcp" };
    fullName = `mcp__${tokens[0]}__${tokens[1]}`;
    // Preserve the JSON part verbatim (it may contain spaces).
    const m = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    rest = m?.[3] ?? "";
  }
  if (!rest) return { fullName, args: {} };
  try {
    const parsed = JSON.parse(rest) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "json args must be an object, e.g. {\"prompt\": \"...\"}" };
    }
    return { fullName, args: parsed as Record<string, unknown> };
  } catch {
    return { error: `invalid JSON args: ${rest.slice(0, 80)}` };
  }
}
