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
import type { AgentConfig } from "../config.js";
import { listSessions, resolveSessionId, type SessionFile, type SessionSummary } from "../session.js";
import { discoverSkills, type Skill } from "../skills.js";
import { formatSlashHelp, parseMcpExec, BUILTIN_COMMANDS, resolveCommandDef, type SlashCommand, type CommandDef, type CommandVisibility } from "./commands.js";

// ── Host facade ─────────────────────────────────────────────────────────────

/** Kết quả xử lý command: frontend hiển thị notice (nếu có) và hành động. */
export interface CommandOutcome {
  /** Text hiển thị cho user (handler đã tự gọi notice() thì bỏ trống). */
  notice?: string;
  /** Level của notice (default "info"). */
  level?: "info" | "warn" | "error";
  /** REPL: thoát vòng lặp. TUI: exit(). */
  quit?: boolean;
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
  /** Agent đang chạy task? (/sessions resume gate — TUI) */
  isRunning?(): boolean;
  /** Thay agent hiện tại: agent=null → tạo mới từ config (/clear); /sessions resume. */
  replaceAgent(agent: Agent | null): void;
  /** Resume + chạy tiếp trong foreground (REPL: console; TUI: tự quản running state). */
  resumeAndRun?(session: SessionFile): Promise<AgentRunResult>;
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
  status: Array<{ name: string; command: string; connected: boolean; tools: Array<{ name: string; description?: string }> }>,
): string {
  if (status.length === 0) return "no MCP servers configured — add mcpServers to .scoderrc.json";
  return status
    .map(
      (srv) =>
        `${srv.connected ? "✓" : "·"} ${srv.name} — ${srv.command}` +
        (srv.connected ? ` (${srv.tools.length} tools)\n` + srv.tools.map((t) => `    mcp__${srv.name}__${t.name}  ${t.description ?? ""}`).join("\n") : " (not connected)"),
    )
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
      description: "list discovered skills (SKILL.md)",
      run(_slash, host, notice) {
        notice(formatSkills(host.agent()?.getSkills() ?? discoverSkills(host.config.workdir)));
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
        host.config = withPermissionMode(host.config, mode);
        notice(`permission mode → ${mode}`);
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
