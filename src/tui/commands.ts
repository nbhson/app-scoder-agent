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

// ── v2 skeleton: một nguồn duy nhất cho command metadata ─────────────────────
// Phase 6 hoàn thiện registry (handler + completion + visibility enforcement);
// Phase 0 chỉ chốt hình dạng CommandDef và để SLASH_COMMANDS suy ra từ đây —
// xoá nguy cơ 2 danh sách lệch nhau. Handler vẫn sống ở command-registry.ts /
// frontend-specific (không import agent ở module thuần này).
export type CommandVisibility = "public" | "hidden" | "tui-only";
export type CommandSource = "builtin" | "project" | "global" | "mcp";

export interface CommandDef {
  /** Canonical name including the leading slash, e.g. "/help". */
  name: string;
  aliases: string[];
  description: string;
  /** Usage line, e.g. "/sessions resume <id|last>" (defaults to /name). */
  usage: string;
  visibility: CommandVisibility;
  source: CommandSource;
}

/** Built-in commands — the single catalog both help and completion read. */
export const BUILTIN_COMMANDS: CommandDef[] = [
  { name: "/help", aliases: [], description: "show this command list", usage: "/help", visibility: "public", source: "builtin" },
  { name: "/plan", aliases: [], description: "show the current plan — /plan done|start <id|n> to mark steps", usage: "/plan [done|start <id|n|text>]", visibility: "public", source: "builtin" },
  { name: "/agent", aliases: [], description: "list selectable agents — /agent <name> to switch (idle only)", usage: "/agent [name]", visibility: "public", source: "builtin" },
  { name: "/init", aliases: [], description: "create an AGENTS.md template in this project", usage: "/init", visibility: "public", source: "builtin" },
  { name: "/sessions", aliases: [], description: "list saved sessions — /sessions resume <id|last>", usage: "/sessions [resume <id|last>]", visibility: "public", source: "builtin" },
  { name: "/diff", aliases: [], description: "show diffs: /diff turn | session | branch", usage: "/diff [turn|session|branch]", visibility: "tui-only", source: "builtin" },
  { name: "/theme", aliases: [], description: "switch palette: /theme <name> — /theme list (mission|paper|mono|light|high-contrast|solarized)", usage: "/theme [name|list]", visibility: "tui-only", source: "builtin" },
  { name: "/clear", aliases: [], description: "clear the conversation and reset agent context", usage: "/clear", visibility: "public", source: "builtin" },
  { name: "/compact", aliases: [], description: "summarize older history now (manual compaction)", usage: "/compact", visibility: "public", source: "builtin" },
  { name: "/cost", aliases: [], description: "token usage of the current session", usage: "/cost", visibility: "public", source: "builtin" },
  { name: "/model", aliases: [], description: "show the active model & provider", usage: "/model [provider/model]", visibility: "public", source: "builtin" },
  { name: "/skills", aliases: [], description: "list discovered skills (SKILL.md)", usage: "/skills", visibility: "public", source: "builtin" },
  { name: "/skill", aliases: [], description: "load a skill into context: /skill <name>", usage: "/skill <name>", visibility: "public", source: "builtin" },
  { name: "/mcp", aliases: [], description: "MCP servers & tools: /mcp [server] [tool] [json|text]", usage: "/mcp [server [tool [json]]]", visibility: "public", source: "builtin" },
  { name: "/review", aliases: [], description: "prompt gate: rewrite + user approval — /review <prompt>", usage: "/review <prompt>", visibility: "tui-only", source: "builtin" },
  { name: "/permission", aliases: [], description: "view or switch permission mode: /permission <auto|ask|readonly>", usage: "/permission [auto|ask|readonly]", visibility: "public", source: "builtin" },
  { name: "/undo", aliases: [], description: "revert files: /undo [files|edit] — edit also trims the turn back for re-send", usage: "/undo [files|edit]", visibility: "tui-only", source: "builtin" },
  { name: "/commands", aliases: [], description: "list all commands (builtin + custom) — /commands <name> to inspect", usage: "/commands [name]", visibility: "public", source: "builtin" },
  { name: "/export", aliases: [], description: "export session transcript: /export [md|json]", usage: "/export [md|json]", visibility: "public", source: "builtin" },
  { name: "/search", aliases: [], description: "search transcript: /search <query>", usage: "/search <query>", visibility: "public", source: "builtin" },
  { name: "/exit", aliases: ["/quit"], description: "quit (aliases: /quit, exit, quit)", usage: "/exit", visibility: "public", source: "builtin" },
];

/** Back-compat view used by completion + /help — derived from BUILTIN_COMMANDS. */
export const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = BUILTIN_COMMANDS
  .filter((c) => c.visibility !== "hidden")
  .map((c) => ({ cmd: c.name, desc: c.description }));

/** Resolve a command name or alias → canonical CommandDef (case-insensitive). */
export function resolveCommandDef(name: string): CommandDef | undefined {
  const n = name.toLowerCase();
  return BUILTIN_COMMANDS.find((c) => c.name === n || c.aliases.includes(n));
}

/** Parse "/cmd arg…"; returns null when the input is not a slash command. */
export function parseSlashCommand(input: string): SlashCommand | null {
  const m = /^\/([a-zA-Z][a-zA-Z0-9-]*)(?:\s+([\s\S]*\S))?\s*$/.exec(input.trim());
  if (!m) return null;
  return { cmd: resolveCommandDef("/" + m[1].toLowerCase())?.name ?? "/" + m[1].toLowerCase(), arg: m[2] ?? "" };
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

// ── T-02: completion-provider interface ─────────────────────────────────────
// One provider per resource kind; the Input overlay asks every provider for
// candidates and renders one ranked list. Providers are sync + cheap (≤200ms
// p95 SLO): sources are in-memory lists or the T-01 cached file index.

export interface CompletionCandidate {
  label: string;
  desc?: string;
  /** Inserted text (replaces the current token). */
  insert: string;
}

export interface CompletionProvider {
  /** Source id — also the overlay section header. */
  id: string;
  /** Does this provider own the current token? (e.g. token starts with "@") */
  match(token: string): boolean;
  candidates(token: string): CompletionCandidate[];
}

import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename, extname } from "node:path";
import { suggest } from "./at-complete.js";

// ── Custom commands discovery (Phase 6) ──────────────────────────────────────

export type CustomCommandExecMode = "prompt" | "agent" | "shell";

export interface CustomCommand {
  name: string;
  description: string;
  visibility: CommandVisibility;
  aliases: string[];
  /** @default "prompt" */
  exec?: CustomCommandExecMode;
  /** Agent name for exec:"agent" */
  agent?: string;
  /** Model for exec:"agent" */
  model?: string;
  /** Shell command for exec:"shell" */
  shell?: string;
  /** Argument names (positional) for $1..$n substitution. */
  args?: string[];
  /** Frontmatter body (raw) for exec:"prompt". */
  body: string;
  source: CommandSource;
  filePath: string;
}

/** Substitute $ARGUMENTS, $1..$n, @file references in the body. */
function substituteTemplate(body: string, argStr: string): string {
  const args = argStr.trim().split(/\s+/).filter(Boolean);
  let out = body;
  out = out.replace(/\$ARGUMENTS/g, argStr.trim());
  for (let i = 0; i < args.length; i++) {
    out = out.replace(new RegExp(`\\$${i + 1}`, "g"), args[i]);
  }
  out = out.replace(/\$ARGUMENTS/g, argStr.trim()); // repeat in case $ARGUMENTS contains $1
  // @file references — leave as-is (agent interprets them).
  return out;
}

/** Discover custom commands from ~/.scoder/commands/*.md + .scoder/commands/*.md. */
export function discoverCustomCommands(workdir: string): CustomCommand[] {
  const dirs = [resolve(workdir, ".scoder", "commands"), join(homedir(), ".scoder", "commands")].filter((d) => existsSync(d));

  const results: CustomCommand[] = [];
  for (const dir of dirs) {
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (extname(file) !== ".md") continue;
      const filePath = join(dir, file);
      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      if (!stat.isFile()) continue;
      const content = readFileSync(filePath, "utf8");
      const parsed = parseCustomCommandFile(basename(file, ".md"), filePath, content);
      if (parsed) results.push(parsed);
    }
  }
  return results;
}

/** Parse a custom command .md file. Returns null on error. */
function parseCustomCommandFile(
  defaultName: string,
  filePath: string,
  content: string,
): CustomCommand | null {
  const source: CommandSource = /[\\/]\.scoder[\\/]commands[\\/]/.test(filePath) ? "project" : "global";

  const frontMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content.trim());
  if (!frontMatch) {
    // No frontmatter: body is the entire file, name is filename.
    return {
      name: defaultName,
      description: content.trim().slice(0, 80),
      visibility: "public",
      aliases: [],
      body: content.trim(),
      source,
      filePath,
    };
  }

  const frontRaw = frontMatch[1];
  const body = frontMatch[2].trim();

  // Parse YAML frontmatter manually (no external dependency).
  const front: Record<string, unknown> = {};
  for (const line of frontRaw.split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (m) {
      const [, key, rawVal] = m;
      front[key] = rawVal.startsWith('"') && rawVal.endsWith('"')
        ? rawVal.slice(1, -1)
        : rawVal;
    }
  }

  return {
    name: String(front.name ?? defaultName),
    description: String(front.description ?? body.split("\n")[0].slice(0, 80)),
    visibility: (front.visibility as CommandVisibility) ?? "public",
    aliases: Array.isArray(front.aliases) ? front.aliases.map(String) : [],
    exec: (front.exec as CustomCommandExecMode) ?? "prompt",
    agent: front.agent ? String(front.agent) : undefined,
    model: front.model ? String(front.model) : undefined,
    shell: front.shell ? String(front.shell) : undefined,
    args: front.args
      ? (Array.isArray(front.args)
          ? front.args.map(String)
          : String(front.args)
            // YAML flow array "[a, b]" → strip brackets, split on comma.
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean))
      : undefined,
    body,
    source,
    filePath,
  };
}

/** Substitute + execute a custom command; returns the prompt text to inject. */
export function runCustomCommand(cmd: CustomCommand, argStr: string): string {
  return substituteTemplate(cmd.body, argStr);
}

/** Build providers from runtime context (called once per keystroke burst). */
export function completionProviders(sources: {
  skills: string[];
  agents: string[];
  files: string[];
}): CompletionProvider[] {
  return [
    {
      id: "commands",
      match: (t) => t.startsWith("/") && !t.slice(1).includes(" "),
      candidates: (t) =>
        SLASH_COMMANDS.filter((c) => c.cmd.startsWith(t.toLowerCase()))
          .map((c) => ({ label: c.cmd, desc: c.desc, insert: c.cmd + " " })),
    },
    {
      id: "files",
      match: (t) => t.startsWith("@") && t.length > 1,
      candidates: (t) =>
        suggest(sources.files, t.slice(1)).map((f) => ({ label: f, insert: "@" + f + (f.endsWith("/") ? "" : " ") })),
    },
    {
      id: "skills",
      match: (t) => t.startsWith("@") && t.length > 1,
      candidates: (t) => {
        const q = t.slice(1).toLowerCase();
        return sources.skills
          .filter((s) => s.toLowerCase().includes(q))
          .slice(0, 4)
          .map((s) => ({ label: `@${s}`, desc: "skill", insert: `@${s} ` }));
      },
    },
    {
      id: "agents",
      match: (t) => t.startsWith("@") && t.length > 1,
      candidates: (t) => {
        const q = t.slice(1).toLowerCase();
        return sources.agents
          .filter((a) => a.toLowerCase().includes(q))
          .slice(0, 4)
          .map((a) => ({ label: `@${a}`, desc: "agent", insert: `@${a} ` }));
      },
    },
  ];
}

/**
 * Ghost text: when the current input has exactly ONE candidate across all
 * providers and it extends the typed token, return the remainder to render
 * dim after the cursor (Tab accepts). Returns null otherwise.
 */
export function ghostText(
  value: string,
  providers: CompletionProvider[],
): { rest: string; insert: string } | null {
  const tokens = value.split(/\s/);
  const token = tokens[tokens.length - 1] ?? "";
  if (!token || value.endsWith(" ")) return null;
  const all: CompletionCandidate[] = [];
  for (const p of providers) {
    if (!p.match(token)) continue;
    all.push(...p.candidates(token));
    if (all.length > 1) return null;
  }
  if (all.length !== 1) return null;
  const insert = all[0].insert;
  // Ghost shows only the unread part of a plain extension (no replacement).
  if (!insert.toLowerCase().startsWith(token.toLowerCase())) return null;
  const rest = insert.slice(token.length);
  if (!rest) return null;
  return { rest, insert };
}

/** Format the /help listing (shared so both frontends render identically). */
export function formatSlashHelp(commandName: string): string {
  const rows = SLASH_COMMANDS.map((c) => `  ${c.cmd.padEnd(12)} ${c.desc}`).join("\n");
  return `Commands (${commandName}):\n${rows}\n  Anything else is sent to the agent as a task.\n  Tab completes commands; ↑/↓ recalls history.`;
}

/**
 * Tab completion for `/mcp` arguments: server name, then tool name.
 * Input forms: "/mcp " → servers; "/mcp srv " → srv's tools; "/mcp srv par" → tools starting "par".
 * Returns the completed text or null.
 */
export function completeMcpArg(
  input: string,
  servers: Array<{ name: string; tools: Array<{ name: string }> }>,
): string | null {
  const m = /^\/mcp\s+(\S*)$/.exec(input);
  if (m) {
    // Đang gõ tên server.
    const partial = m[1].toLowerCase();
    const hits = servers.filter((s) => s.name.toLowerCase().startsWith(partial));
    if (hits.length === 1) return `/mcp ${hits[0].name} `;
    if (hits.length > 1) {
      let prefix = hits[0].name;
      for (const h of hits.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < h.name.length && prefix[i] === h.name[i]) i++;
        prefix = prefix.slice(0, i);
      }
      return `/mcp ${prefix}`;
    }
    return null;
  }
  const tm = /^\/mcp\s+(\S+)\s+(\S*)$/.exec(input);
  if (tm) {
    // Đang gõ tên tool (bỏ prefix mcp__srv__ khi gõ).
    const srv = servers.find((s) => s.name.toLowerCase() === tm[1].toLowerCase());
    if (!srv) return null;
    const partial = tm[2].toLowerCase().replace(/^mcp__\S+?__/, "");
    const hits = srv.tools.filter((t) => t.name.toLowerCase().startsWith(partial));
    if (hits.length === 1) return `/mcp ${srv.name} ${hits[0].name} `;
    if (hits.length > 1) {
      let prefix = hits[0].name;
      for (const h of hits.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < h.name.length && prefix[i] === h.name[i]) i++;
        prefix = prefix.slice(0, i);
      }
      return `/mcp ${srv.name} ${prefix}`;
    }
  }
  return null;
}

/**
 * Parse a `/mcp` exec invocation into (fullName, args).
 *
 * Forms:
 *   /mcp                                  → list (no exec)
 *   /mcp server tool {"k":"v"}            → mcp__server__tool
 *   /mcp mcp__server__tool {"k":"v"}      → as-is (full name)
 *   /mcp server tool free text            → args resolved from the tool's
 *                                           first string parameter (see
 *                                           Agent.callMcpTool `__text`)
 * The JSON part is optional; non-JSON text is passed as the `__text` shorthand.
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
    // Not JSON — treat the rest as the value of the tool's first required
    // string parameter (discoverable from its inputSchema via /mcp listing),
    // e.g. `/mcp exec mcp__srv__tool phân tích project`.
    return { fullName, args: { __text: rest } };
  }
}
