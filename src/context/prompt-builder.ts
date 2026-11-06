/**
 * I3: Prompt builder — lắp system prompt từ các phần: base + env snapshot +
 * skills advertised + subagents. Module thuần (chỉ spawnSync git), test được
 * độc lập. Trước đây logic này rải trong agent.ts (~50 dòng).
 */
import { spawnSync } from "node:child_process";
import { formatSkillIndex, type Skill } from "./skills.js";
import type { AgentDef } from "./agents.js";
import type { AgentConfig } from "../config/config.js";

// P2: memoize per (workdir, date, platform, node version) — the git probe is a
// spawned process and the output cannot change for a given key within a run.
// The date is part of the key, so nothing is cached across a day boundary.
const envInfoCache = new Map<string, string>();

/** One-line environment snapshot for the system prompt (cache-stable per run). */
export function buildEnvInfo(workdir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `${workdir}|${process.platform}|${process.version}|${today}`;
  const hit = envInfoCache.get(cacheKey);
  if (hit !== undefined) return hit;
  let git = "";
  try {
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workdir, encoding: "utf8" });
    if (branch.status === 0) git = ` · git:${branch.stdout.trim()}`;
  } catch {
    /* git unavailable */
  }
  const info = `Environment: ${process.platform} · node ${process.version}${git} · today ${today}`;
  envInfoCache.set(cacheKey, info);
  return info;
}

/** Skills advertised in system prompt (passive listing only — agent does NOT auto-load). */
export function buildSkillsBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return (
    `\n\nAVAILABLE SKILLS (load with /skill <name> or when the task clearly matches a skill domain):\n${formatSkillIndex(skills)}\n` +
    "Only load a skill when the user explicitly requests it with /skill, or when the task description clearly matches a skill's domain. Do NOT load skills merely because they are listed."
  );
}

/** Subagents khả dụng (task tool) — chỉ khi agent được phép spawn. */
export function buildAgentsBlock(agents: AgentDef[], allowSubagents: boolean): string {
  const usable = agents.filter((a) => a.mode !== "subagent" || a.name === "explore");
  if (!allowSubagents || usable.length === 0) return "";
  return (
    `\n\nSUBAGENTS (via the task tool — delegate focused sub-work):\n` +
    usable.map((a) => `  ${a.name.padEnd(12)} ${a.description}`).join("\n") +
    "\nDelegate exploration or planning when it keeps the main loop focused."
  );
}

/** MCP servers advertised in system prompt (passive listing only — never auto-used). */
export function buildMcpBlock(config: AgentConfig): string {
  const servers = Object.keys(config.mcpServers ?? {});
  if (servers.length === 0) return "";
  return (
    `\n\nMCP SERVERS (available tools — use mcp__<server>__<tool> ONLY when the task explicitly requires external integration):\n` +
    servers.map((n) => `- ${n}`).join("\n") +
    "\nDo NOT call MCP tools unless the user explicitly asks for external integration or the task requires it."
  );
}

/** Ghép phần động vào system prompt gốc (buildSystemPrompt giữ ở prompt.ts). */
export { buildSystemPrompt } from "./prompt.js";
