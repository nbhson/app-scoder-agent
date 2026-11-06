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
import type { Agent, UsageTotals } from "../agent.js";
import type { AgentConfig } from "../config/config.js";
import { discoverSkills, matchSkillPrefix, type Skill } from "../context/skills.js";
import { selectableAgents } from "../context/agents.js";
import { agentsMdTemplate } from "../context/agents-guide.js";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatSlashHelp, parseMcpExec, BUILTIN_COMMANDS, resolveCommandDef, discoverCustomCommands, runCustomCommand, type SlashCommand, type CommandDef, type CommandVisibility } from "./definitions.js";

// ── Host facade ─────────────────────────────────────────────────────────────

/** Kết quả xử lý command: frontend hiển thị notice (nếu có) và hành động. */
export interface CommandOutcome {
  /** Text hiển thị cho user (handler đã tự gọi notice() thì bỏ trống). */
  notice?: string;
  /** Level của notice (default "info"). */
  level?: "info" | "warn" | "error";
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
  /** Agent đang chạy task? (/compact, /agent switch gate — TUI) */
  isRunning?(): boolean;
  /** Thay agent hiện tại: agent=null → tạo mới từ config (/clear). */
  replaceAgent(agent: Agent | null): void;
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
 * Handlers dùng chung. Command đặc thù frontend (/theme — chỉ TUI) KHÔNG nằm
 * đây — frontend xử lý trước khi dispatch, rồi mới gọi dispatchCommand() cho
 * phần còn lại.
 */
export function coreCommands(): CommandEntry[] {
  return [
    {
      name: "/help",
      description: "show this command list (builtin + custom)",
      run(_slash, host, notice) {
        const custom = discoverCustomCommands(host.config.workdir).map((c) => ({ cmd: "/" + c.name, desc: c.description }));
        notice(formatSlashHelp("scoder tui", custom));
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
      name: "/skill",
      description: "list skills, or load one into context: /skill <name> [task]",
      run(slash, host, notice) {
        if (!slash.arg) {
          notice(formatSkills(host.agent()?.getSkills() ?? discoverSkills(host.config.workdir)));
          return;
        }
        const agent = host.agent();
        if (!agent) return notice("agent not ready — start a task first", "warn");
        // "/skill <name> <task…>": stage rồi CHẠY task luôn — skill áp dụng
        // ngay cho prompt đó (trước đây task text bị nuốt vào tham số name).
        const m = matchSkillPrefix(host.config.workdir, slash.arg);
        const r = agent.stageSkill(m ? m.skill.name : slash.arg);
        notice(r.message, r.ok ? "info" : "error");
        if (r.ok && m?.rest) return { task: m.rest };
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
        notice(`agent → ${name} (${def.mode}) — conversation reset; \`scoder resume last\` resumes the previous one`);
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
 * slash command. Frontend xử lý command riêng (TUI: /theme; REPL: không có)
 * TRƯỚC khi gọi hàm này.
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
  // Resolve aliases → canonical command.
  const resolved = resolveCommandDef(raw);
  const cmd = resolved?.name ?? raw;
  const slash: SlashCommand = { cmd, arg };
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
