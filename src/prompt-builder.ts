/**
 * I3: Prompt builder — lắp system prompt từ các phần: base + env snapshot +
 * skills advertised + subagents. Module thuần (chỉ spawnSync git), test được
 * độc lập. Trước đây logic này rải trong agent.ts (~50 dòng).
 */
import { spawnSync } from "node:child_process";
import { formatSkillIndex, type Skill } from "./skills.js";
import type { AgentDef } from "./agents.js";

/** One-line environment snapshot for the system prompt (cache-stable per run). */
export function buildEnvInfo(workdir: string): string {
  let git = "";
  try {
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workdir, encoding: "utf8" });
    if (branch.status === 0) git = ` · git:${branch.stdout.trim()}`;
  } catch {
    /* git unavailable */
  }
  return `Environment: ${process.platform} · node ${process.version}${git} · today ${new Date().toISOString().slice(0, 10)}`;
}

/** Skills advertised trong system prompt (dynamic selection hint). */
export function buildSkillsBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return (
    `\n\nAVAILABLE SKILLS (project + global .scoder/skills/<name>/SKILL.md):\n${formatSkillIndex(skills)}\n` +
    "Dynamic selection: BEFORE planning, scan this index against the task. If any skill's description matches the task's domain or workflow, call load_skill with its name FIRST and follow the returned instructions — the skill may change how you approach the whole task. Do not load a skill merely because it is listed; only when it genuinely matches. If two skills match, prefer the more specific one."
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

/** Ghép phần động vào system prompt gốc (buildSystemPrompt giữ ở prompt.ts). */
export { buildSystemPrompt } from "./prompt.js";
