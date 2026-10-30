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
  { cmd: "/exit", desc: "quit (aliases: /quit, exit, quit)" },
];

/** Parse "/cmd arg…"; returns null when the input is not a slash command. */
export function parseSlashCommand(input: string): SlashCommand | null {
  const m = /^\/([a-zA-Z][a-zA-Z0-9]*)(?:\s+(.*\S))?\s*$/.exec(input.trim());
  if (!m) return null;
  return { cmd: "/" + m[1].toLowerCase(), arg: m[2] ?? "" };
}

/** Format the /help listing (shared so both frontends render identically). */
export function formatSlashHelp(commandName: string): string {
  const rows = SLASH_COMMANDS.map((c) => `  ${c.cmd.padEnd(8)} ${c.desc}`).join("\n");
  return `Commands (${commandName}):\n${rows}\n  Anything else is sent to the agent as a task.`;
}
