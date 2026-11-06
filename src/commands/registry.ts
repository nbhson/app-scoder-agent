/**
 * T1: Command registry dùng chung cho REPL (src/index.ts) + Ink TUI
 * (src/tui/app.tsx) — xoá ~200 dòng switch if-chain trùng lặp.
 *
 * Pattern từ opencode (packages/core/src/command.ts): mỗi command là một bản
 * ghi {name, description, handler}. Frontend chỉ dispatch — handler nhận
 * CommandHost (facade lên agent/state) và trả về kết quả hiển thị.
 *
 * Khác commands.ts (pure parsing): module này CHỨA handler — cần Agent, nên
 * nằm ở tui/ nhưng không import ink/react (unit-test được).
 */
import type { Agent, AgentRunResult, UsageTotals } from "../agent.js";
import type { TranscriptItem } from "./types.js";
import type { AgentConfig } from "../config/config.js";
import { listSessions, resolveSessionId, type SessionFile, type SessionSummary } from "../session/session.js";
import { discoverSkills, skillWarnings, type Skill } from "../skills.js";
import { selectableAgents } from "../agents.js";
import { agentsMdTemplate } from "../agents-guide.js";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatSlashHelp, parseMcpExec, BUILTIN_COMMANDS, resolveCommandDef, discoverCustomCommands, runCustomCommand, type SlashCommand, type CommandDef, type CommandVisibility } from "./definitions.js";
import { exportTranscript, findInTranscript, type TranscriptMatch } from "./transcript.js";

// ── Host facade ─────────────────────────────────────────────────────────────

/** Kết quả xử lý command: frontend hiển thị notice (nếu có) và hành động. */
export interface CommandOutcome {
  /** Text hiển thị cho user (handler đã tự gọi notice() thì bỏ trống). */
  notice?: string;
  /** Level của notice (default "info"). */
  level?: "info" | "warn" | "error";
  /** REPL: thoát vòng lặp. TUI: exit(). */
  quit?: boolean;
  /** Prompt produced by a custom command; the frontend submits it normally. */
  task?: string;
}

/**
 * Facade frontend cung cấp cho handlers. Hai frontend implement khác nhau:
 *  - REPL: agent trực tiếp + console
 *  - TUI: agentRef + reducer notices
 */
export interface CommandHost {
  /** Agent hiện tại (TUI: createAgent() lazy — null khi chưa chạy). */
  agent(): Agent | null;
  config: AgentConfig;
  /**
   * Patch the *effective* config (TUI: setState; REPL: mutate the shared cfg
   * object). Handlers that change config MUST use this when present — a bare
   * `host.config = …` would not reach the frontend's createAgent path.
   */
  updateConfig?(patch: Partial<AgentConfig>): void;
  /** Agent đang chạy task? (/sessions resume gate — TUI) */
  isRunning?(): boolean;
  /** Thay agent hiện tại: agent=null → tạo mới từ config (/clear); /sessions resume. */
  replaceAgent(agent: Agent | null): void;
  /** Resume + chạy tiếp trong foreground (REPL: console; TUI: tự quản running state). */
  resumeAndRun?(session: SessionFile): Promise<AgentRunResult>;
  /** [TUI] Current transcript items — used by /export and /search. */
  transcriptItems?(): TranscriptItem[];
  /** [TUI] Scroll to a transcript item by index (/search navigation). */
  selectTranscriptItem?(index: number): void;
}

/** UI sink — mỗi frontend cung cấp một hàm hiển thị. */
export type NoticeSink = (text: string, level?: "info" | "warn" | "error") => void;

// ── Registry ────────────────────────────────────────────────────────────────

export interface CommandEntry {
  name: string;
  description: string;
  /** Usage line for /help (defaults to name + "<args>" when absent). */
  usage?: string;
  /** Alternate names that dispatch to this command. */
  aliases?: string[];
  /** public = all frontends; tui-only = Ink only; hidden = not listed in /help. */
  visibility?: CommandVisibility;
  /** Where the command comes from (custom commands land as project/global later). */
  source?: CommandDef["source"];
  /** Ném lỗi → dispatcher bắt và chuyển thành error notice. */
  run(slash: SlashCommand, host: CommandHost, notice: NoticeSink): Promise<CommandOutcome | void> | CommandOutcome | void;
}

/** Format usage/cost block (dùng chung — REPL console.log, TUI notice). */
export function formatUsage(u: UsageTotals): string {
  return u.calls > 0
    ? `session usage: ${u.calls} LLM calls · tokens in ${u.inputTokens} / out ${u.outputTokens}` +
        (u.cachedTokens > 0 ? ` (+${u.cachedTokens} cached)` : "")
    : "no LLM calls yet in this session";
}

/** Format skills listing (dùng chung). */
export function formatSkills(skills: Skill[]): string {
  if (skills.length === 0) {
    return "no skills discovered — add .scoder/skills/<name>/SKILL.md (name + description frontmatter)";
  }
  return (
    "Skills:\n" +
    skills
      .map((s) => `  ${s.name.padEnd(20)} ${s.description || "(no description)"}  [${s.scope}]`)
      .join("\n")
  );
}

/** Format sessions listing (dùng chung). */
export function formatSessions(all: SessionSummary[]): string {
  return all.length === 0
    ? "no saved sessions — completed runs auto-save to .scoder/sessions/"
    : all.slice(0, 10).map((x) => `${x.id.slice(0, 8)}  ${x.updatedAt.slice(0, 16).replace("T", " ")}  ${x.steps} steps  ${x.task}`).join("\n") +
        "\nresume: /sessions resume <id|last>";
}

/** Format MCP status listing (dùng chung). */
export function formatMcpStatus(
  status: Array<{
    name: string;
    command: string;
    connected: boolean;
    tools: Array<{ name: string; description?: string }>;
    serverInfo?: { name?: string; version?: string };
    capabilities?: Record<string, unknown>;
    resourceCount?: number;
    promptCount?: number;
  }>,
): string {
  if (status.length === 0) return "no MCP servers configured — add mcpServers to .scoderrc.json";
  return status
    .map((srv) => {
      const capParts: string[] = [];
      if (srv.serverInfo?.name) capParts.push(srv.serverInfo.name + (srv.serverInfo.version ? " v" + srv.serverInfo.version : ""));
      if (srv.capabilities?.ping === true) capParts.push("ping");
      if (srv.capabilities?.tools) capParts.push("tools");
      if (srv.capabilities?.resources) capParts.push("resources");
      if (srv.capabilities?.prompts) capParts.push("prompts");
      const capTag = capParts.length > 0 ? ` [${capParts.join(", ")}]` : "";
      const counts = [
        `${srv.tools.length} tools`,
        ...(srv.resourceCount ? [`${srv.resourceCount} resources`] : []),
        ...(srv.promptCount ? [`${srv.promptCount} prompts`] : []),
      ].join(", ");
      return (
        `${srv.connected ? "✓" : "·"} ${srv.name} — ${srv.command}${capTag}` +
        (srv.connected
          ? ` (${counts})\n` +
            srv.tools.map((t) => `    mcp__${srv.name}__${t.name}  ${t.description ?? ""}`).join("\n")
          : " (not connected)")
      );
    })
    .join("\n");
}

/**
 * Handlers dùng chung. Command đặc thù frontend (/review, /undo, /theme — chỉ
 * TUI; /diff TUI có turn-scope riêng) KHÔNG nằm đây — frontend xử lý trước
 * khi dispatch, rồi mới gọi dispatchCommand() cho phần còn lại.
 */
export function coreCommands(): CommandEntry[] {
  return [
    {
      name: "/help",
      description: "show this command list",
      run(_slash, _host, notice) {
        notice(formatSlashHelp("scoder tui"));
      },
    },
    {
      name: "/cost",
      description: "token usage of the current session",
      run(_slash, host, notice) {
        notice(formatUsage(host.agent()?.getUsage() ?? { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }));
      },
    },
    {
      name: "/compact",
      description: "summarize older history now (manual compaction)",
      async run(_slash, host, notice) {
        const agent = host.agent();
        if (!agent) return notice("agent not ready — start a task first", "warn");
        if (host.isRunning?.()) return notice("agent is running — wait or Esc first", "warn");
        const r = await agent.compactHistory();
        notice(r.message, r.ok ? "info" : "warn");
      },
    },
    {
      name: "/skills",
      description: "list/info/lint/reload skills — /skills [info <name>|lint|reload]",
      run(slash, host, notice) {
        const arg = slash.arg.trim();
        const skills = host.agent()?.getSkills() ?? discoverSkills(host.config.workdir);
        if (!arg) { notice(formatSkills(skills)); return; }
        const parts = arg.split(/\s+/);
        const sub = parts[0].toLowerCase();
        if (sub === "info") {
          const name = parts.slice(1).join(" ").trim();
          if (!name) return notice("usage: /skills info <name>", "warn");
          const skill = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
          if (!skill) return notice(`skill "${name}" not found`, "error");
          const lines = [
            `# ${skill.name}${skill.version ? ` v${skill.version}` : ""}`,
            `description: ${skill.description}`,
            `scope: ${skill.scope}`,
            skill.tags?.length ? `tags: ${skill.tags.join(", ")}` : null,
            skill.allowedTools?.length ? `allowed-tools: ${skill.allowedTools.join(", ")}` : null,
            skill.references?.length ? `references: ${skill.references.join(", ")}` : null,
            skill.whenToUse ? `when-to-use: ${skill.whenToUse}` : null,
            "",
            skill.body,
          ].filter(Boolean);
          notice(lines.join("\n"));
          return;
        }
        if (sub === "lint") {
          const warnings = skillWarnings.filter((w) => !host.config.workdir || w.path.startsWith(host.config.workdir));
          if (warnings.length === 0) return notice("skills lint: ok (no warnings)", "info");
          notice(warnings.map((w) => `${w.path}: ${w.message}`).join("\n"), "warn");
          return;
        }
        if (sub === "reload") {
          const ag = host.agent();
          if (ag) ag.reloadSkills?.();
          notice(formatSkills(host.agent()?.getSkills() ?? discoverSkills(host.config.workdir)));
          return;
        }
        // default: treat arg as skill name → show info
        const skill = skills.find((s) => s.name.toLowerCase() === arg.toLowerCase());
        if (skill) {
          notice(`# ${skill.name}\n${skill.description}\n${skill.body.slice(0, 500)}`, "info");
          return;
        }
        notice(`unknown /skills subcommand: ${arg}`, "error");
      },
    },
    {
      name: "/skill",
      description: "load a skill into context: /skill <name>",
      run(slash, host, notice) {
        if (!slash.arg) return notice("usage: /skill <name>", "warn");
        const r = host.agent()?.stageSkill(slash.arg);
        if (!r) return notice("agent not ready", "warn");
        notice(r.message, r.ok ? "info" : "error");
      },
    },
    {
      name: "/mcp",
      description: "MCP servers & tools: /mcp [server] [tool] [json|text]",
      async run(slash, host, notice) {
        const agent = host.agent();
        if (!agent) return notice("agent not ready", "warn");
        const exec = parseMcpExec(slash.arg);
        if (exec === null) {
          notice(formatMcpStatus(await agent.mcpStatus()));
          return;
        }
        if ("error" in exec) return notice(exec.error, "warn");
        notice(`→ ${exec.fullName}`);
        const r = await agent.callMcpTool(exec.fullName, exec.args);
        if (r.ok) notice(r.output.length > 4000 ? r.output.slice(0, 4000) + "\n… (truncated)" : r.output);
        else notice(r.output, "error");
      },
    },
    {
      name: "/model",
      description: "show the active model & provider — /model <provider/model> to hot-swap",
      run(slash, host, notice) {
        if (slash.arg) {
          const agent = host.agent();
          if (!agent) return notice("agent not ready", "warn");
          const msg = agent.setModel(slash.arg.trim());
          notice(msg, msg.startsWith("ERROR") ? "error" : "info");
          return;
        }
        const cfg = host.config;
        notice(`model: ${cfg.model} · provider: ${cfg.provider} · build: ${cfg.buildCmd ?? "auto-detect"}`);
      },
    },
    {
      name: "/permission",
      description: "view or switch permission mode: /permission <auto|ask|readonly>",
      run(slash, host, notice) {
        const mode = slash.arg.toLowerCase();
        if (!["auto", "ask", "readonly"].includes(mode)) {
          notice(`permission mode: ${host.config.permissionMode} — usage: /permission <auto|ask|readonly>`, "warn");
          return;
        }
        host.agent()?.setPermissionMode(mode as "auto" | "ask" | "readonly");
        host.updateConfig?.({ permissionMode: mode as "auto" | "ask" | "readonly" });
        host.config = withPermissionMode(host.config, mode);
        notice(`permission mode → ${mode}`);
      },
    },
    {
      name: "/plan",
      description: "show the current plan — /plan done|start <id|n|text> to mark steps",
      run(slash, host, notice) {
        const agent = host.agent();
        const plan = agent?.getPlan() ?? [];
        if (!slash.arg) {
          if (plan.length === 0) return notice("no plan yet — multi-step tasks get one via write_todos");
          const icon = (s: string) => (s === "completed" ? "✓" : s === "in_progress" ? "▸" : "○");
          notice(
            "Plan:\n" +
              plan
                .map((t, i) => {
                  let line = `  ${icon(t.status)} ${String(i + 1).padStart(2)}. ${t.content}`;
                  if (t.verify) line += `\n       verify: ${t.verify}`;
                  if (t.acceptance) line += `\n       acceptance: ${t.acceptance}`;
                  if (t.files?.length) line += `\n       files: ${t.files.join(", ")}`;
                  return line;
                })
                .join("\n") +
              "\nmark: /plan done <id|n> · /plan start <id|n>",
          );
          return;
        }
        const m = /^(done|start)\s+(.+)$/.exec(slash.arg.trim());
        if (!agent) return notice("agent not ready", "warn");
        if (!m) return notice("usage: /plan [done|start <id|n|text>]", "warn");
        const r = agent.markPlanStep(m[1] === "done" ? "completed" : "in_progress", m[2]);
        notice(r.message, r.ok ? "info" : "warn");
      },
    },
    {
      name: "/agent",
      description: "list selectable agents — /agent <name> to switch (idle only)",
      run(slash, host, notice) {
        const agents = selectableAgents(host.config.workdir);
        const current = host.config.agent ?? "build";
        if (!slash.arg) {
          notice(
            "Agents:\n" +
              agents.map((a) => `  ${a.name === current ? "*" : " "} ${a.name.padEnd(10)} ${a.description}`).join("\n") +
              "\nswitch with /agent <name> (idle only; resets the conversation)",
          );
          return;
        }
        const name = slash.arg.trim();
        const def = agents.find((a) => a.name === name);
        if (!def) {
          return notice(`agent "${name}" not selectable — available: ${agents.map((a) => a.name).join(", ")}`, "error");
        }
        if (current === name) return notice(`already on agent "${name}"`);
        if (host.isRunning?.()) return notice("agent is running — wait or Esc first", "warn");
        host.updateConfig?.({ agent: name });
        host.config = { ...host.config, agent: name };
        host.replaceAgent(null); // fresh agent with the new def; old conversation ends here
        notice(`agent → ${name} (${def.mode}) — conversation reset; /sessions can resume the previous one`);
      },
    },
    {
      name: "/init",
      description: "create an AGENTS.md template in this project",
      run(_slash, host, notice) {
        const target = join(host.config.workdir, "AGENTS.md");
        if (existsSync(target)) {
          notice(`AGENTS.md already exists: ${target}`, "warn");
          return;
        }
        writeFileSync(target, agentsMdTemplate(host.config.workdir), "utf8");
        notice(`created ${target} — review and commit it`);
      },
    },
    {
      name: "/sessions",
      description: "list saved sessions — /sessions resume <id|last>",
      async run(slash, host, notice) {
        if (slash.arg.startsWith("resume")) {
          const ref = slash.arg.replace(/^resume\s*/, "").trim() || "last";
          const s = resolveSessionId(host.config.workdir, ref);
          if (!s) return notice(`session not found: ${ref} — bare /sessions lists saved ones`, "error");
          if (host.isRunning?.()) return notice("agent is running — wait or Esc first", "warn");
          if (host.resumeAndRun) {
            await host.resumeAndRun(s);
            return;
          }
          notice(`resumed session ${s.id.slice(0, 8)}`);
          return;
        }
        notice(formatSessions(listSessions(host.config.workdir)));
      },
    },
    {
      name: "/commands",
      description: "list all commands (builtin + custom) — /commands <name> to inspect",
      run(slash, host, notice) {
        const all = BUILTIN_COMMANDS.map((c) => ({
          name: c.name,
          desc: c.description,
          source: c.source,
        }));
        const custom = discoverCustomCommands(host.config.workdir).map((c) => ({
          name: "/commands " + c.name,
          desc: c.description,
          source: c.source,
        }));
        const combined = [...all, ...custom];
        if (!slash.arg) {
          // List mode — grouped by source.
          const bySource: Record<string, typeof combined> = {};
          for (const c of combined) bySource[c.source] = (bySource[c.source] ?? []).concat(c);
          const sections = Object.entries(bySource)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([src, cmds]) => `  ${src}:\n${cmds.map((c) => `    ${c.name}  ${c.desc}`).join("\n")}`);
          notice(`commands:\n${sections.join("\n\n")}`);
          return;
        }
        // Inspect mode — /commands <name>
        const name = slash.arg.trim().toLowerCase();
        const customCmd = custom.find((c) => c.name === "/commands " + name || c.name === "/commands " + name.slice(1));
        if (customCmd) {
          // Full info for custom command
          const cmd = discoverCustomCommands(host.config.workdir).find(
            (c) => "/commands " + c.name === customCmd.name,
          );
          if (!cmd) return;
          notice(
            `command: ${cmd.name}\n` +
              `description: ${cmd.description}\n` +
              `exec: ${cmd.exec ?? "prompt"}\n` +
              `source: ${cmd.source} — ${cmd.filePath}\n` +
              (cmd.args ? `args: ${cmd.args.join(", ")}\n` : "") +
              `\n${cmd.body.slice(0, 400)}\n` +
              (cmd.body.length > 400 ? "\n… (truncated)" : ""),
          );
          return;
        }
        const builtin = BUILTIN_COMMANDS.find((c) => c.name === "/" + name || c.name === "/commands " + name);
        if (builtin) {
          notice(`${builtin.name}: ${builtin.description}\nusage: ${builtin.usage}`);
          return;
        }
        notice(`command "/${name}" not found`, "warn");
      },
    },
    {
      name: "/export",
      description: "export session transcript: /export [md|json] — writes to workdir/scoder-export.{md|json}",
      run(slash, host, notice) {
        const items = host.transcriptItems ? host.transcriptItems() : [];
        if (items.length === 0) { notice("no transcript to export", "warn"); return; }
        const fmt = (slash.arg.trim().toLowerCase() as "md" | "json") || "md";
        if (fmt !== "md" && fmt !== "json") { notice("usage: /export [md|json]", "warn"); return; }
        const content = exportTranscript(items, fmt);
        const fileName = `scoder-export.${fmt}`;
        const filePath = join(host.config.workdir, fileName);
        try {
          writeFileSync(filePath, "\ufeff" + content, "utf8");
          notice(`exported ${items.length} items → ${filePath}`);
        } catch (e) {
          notice(`export failed: ${(e as Error).message}`, "error");
        }
      },
    },
    {
      name: "/search",
      description: "search transcript: /search <query> — shows snippets; TUI jumps to result",
      run(slash, host, notice) {
        if (!slash.arg.trim()) { notice("usage: /search <query>", "warn"); return; }
        const items = host.transcriptItems ? host.transcriptItems() : [];
        if (items.length === 0) { notice("no transcript to search", "warn"); return; }
        const matches: TranscriptMatch[] = findInTranscript(items, slash.arg);
        if (matches.length === 0) { notice(`no results for "${slash.arg.trim()}"`, "warn"); return; }
        notice(`${matches.length} match${matches.length > 1 ? "es" : ""} in transcript:\n` +
          matches.slice(0, 20).map((m) => `  [${m.index}] ${m.kind}: ${m.snippet}`).join("\n"));
        // TUI: jump to first result
        if (host.selectTranscriptItem && matches.length > 0) {
          host.selectTranscriptItem(matches[0].index);
        }
      },
    },
  ];
}

/** Merged catalog of builtin command metadata — /help & completion read this. */
export function commandCatalog(): CommandDef[] {
  return BUILTIN_COMMANDS.map((def) => ({ ...def }));
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export interface DispatchResult {
  /** true = input là command và đã xử lý (frontend dừng, KHÔNG gửi LLM). */
  handled: boolean;
  outcome: CommandOutcome | null;
}

/** Clone config với permissionMode mới (host.config thay thế được). */
function withPermissionMode(cfg: AgentConfig, mode: string): AgentConfig {
  return { ...cfg, permissionMode: mode as AgentConfig["permissionMode"] };
}

/**
 * Dispatch một input qua registry. Trả về {handled:false} khi không phải
 * slash command. Frontend xử lý command riêng (TUI: /review /undo /theme
 * /diff; REPL: không có) TRƯỚC khi gọi hàm này.
 */
export async function dispatchCommand(
  input: string,
  host: CommandHost,
  notice: NoticeSink,
  extra: CommandEntry[] = [],
): Promise<DispatchResult> {
  const m = /^\/([a-zA-Z][a-zA-Z0-9-]*)(?:\s+([\s\S]*\S))?\s*$/.exec(input.trim());
  if (!m) return { handled: false, outcome: null };
  const raw = "/" + m[1].toLowerCase();
  const arg = m[2] ?? "";
  // Resolve aliases → canonical command (e.g. /quit → /exit).
  const resolved = resolveCommandDef(raw);
  const cmd = resolved?.name ?? raw;
  const slash: SlashCommand = { cmd, arg };
  if (cmd === "/exit" || cmd === "/quit") return { handled: true, outcome: { quit: true } };
  if (cmd === "/clear") {
    host.agent()?.abort();
    host.replaceAgent(null);
    return { handled: true, outcome: { notice: "conversation cleared — context reset" } };
  }
  const custom = discoverCustomCommands(host.config.workdir);
  const customMatch = custom.find((c) => `/${c.name.toLowerCase()}` === cmd || c.aliases.some((a) => `/${a.toLowerCase().replace(/^\//, "")}` === cmd));
  if (customMatch) {
    if (customMatch.exec === "shell") {
      notice(`custom command "${customMatch.name}" declares shell execution; run it explicitly through a reviewed agent task`, "warn");
    } else {
      const prompt = runCustomCommand(customMatch, arg);
      notice(`custom command "${customMatch.name}"`, "info");
      return { handled: true, outcome: { task: prompt } };
    }
    return { handled: true, outcome: {} };
  }
  const entry = [...extra, ...coreCommands()].find((c) => c.name === cmd);
  if (!entry) {
    notice(`unknown command ${cmd} — try /help`, "error");
    return { handled: true, outcome: {} };
  }
  let outcome: CommandOutcome | void;
  try {
    outcome = await entry.run(slash, host, notice);
  } catch (err) {
    notice((err as Error).message, "error");
    return { handled: true, outcome: {} };
  }
  return { handled: true, outcome: outcome ?? {} };
}
