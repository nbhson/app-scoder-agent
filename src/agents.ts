/**
 * Agents (I-06) — .scoder/agents/<name>.md definitions + built-ins.
 *
 * Frontmatter semantics from opencode /v2/docs/agents (concept only —
 * prompt bodies are scoder's own). An agent def is: description, mode
 * (primary|subagent|all), model override, steps, prompt body.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./skills.js";

export interface AgentDef {
  name: string;
  description: string;
  /** primary = selectable as main agent; subagent = only via task tool. */
  mode: "primary" | "subagent" | "all";
  /** Model override ("provider/model" or bare id). */
  model?: string;
  /** Max steps override. */
  steps?: number;
  /** Prompt body (markdown after frontmatter). */
  prompt: string;
  hidden?: boolean;
  disabled?: boolean;
}

/** Built-in agents — lowest priority; .md files override by name. */
export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: "build",
    description: "General coding agent (default) — edits code and runs the build until it passes.",
    mode: "all",
    prompt: "", // empty = use the default system prompt unchanged
  },
  {
    name: "plan",
    description: "Read-only planner — investigates and proposes an implementation plan, never edits code.",
    mode: "primary",
    prompt:
      "You are a planning agent. Investigate the codebase (read files, search, list) and produce a concrete, step-by-step implementation plan. You MUST NOT modify any files or run mutating commands — report the plan and stop. Structure: goal, findings (files/lines), plan steps ordered, risks, and the exact first step to take.",
  },
  {
    name: "explore",
    description: "Read-only subagent — searches and summarizes the codebase, returns findings.",
    mode: "subagent",
    prompt:
      "You are an exploration subagent. Answer the given question about this codebase using read-only tools (list_files, read_file, run_command with read-only commands). Be terse and factual; cite file paths. Do not modify anything.",
  },
];

/** Scan .scoder/agents/*.md (project) + ~/.scoder/agents/*.md (global). */
export function discoverAgents(workdir: string): AgentDef[] {
  const out = new Map<string, AgentDef>();
  for (const b of BUILTIN_AGENTS) out.set(b.name, { ...b });
  // Global overrides builtins; project overrides global.
  for (const root of [join(homedir(), ".scoder", "agents"), join(workdir, ".scoder", "agents")]) {
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root)) {
      if (!f.endsWith(".md")) continue;
      try {
        const { meta, body } = parseFrontmatter(readFileSync(join(root, f), "utf8"));
        const name = f.replace(/\.md$/, "");
        const mode = meta.mode === "primary" || meta.mode === "subagent" ? meta.mode : "all";
        out.set(name, {
          name,
          description: meta.description ?? "",
          mode: mode as AgentDef["mode"],
          model: meta.model || undefined,
          steps: meta.steps ? Number(meta.steps) || undefined : undefined,
          prompt: body,
          hidden: meta.hidden === "true",
          disabled: meta.disabled === "true",
        });
      } catch {
        // skip malformed
      }
    }
  }
  return [...out.values()].filter((a) => !a.disabled);
}

/** Find one agent by name (built-ins included). */
export function findAgent(workdir: string, name: string): AgentDef | null {
  return discoverAgents(workdir).find((a) => a.name === name) ?? null;
}
