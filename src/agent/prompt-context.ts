import type { AgentConfig } from "../config/config.js";
import type { AgentDef } from "../context/agents.js";
import { discoverAgents } from "../context/agents.js";
import { buildAgentGuideBlock } from "../context/agents-guide.js";
import { buildRepoMap } from "../context/repo-map.js";
import { buildSystemPrompt, buildEnvInfo, buildSkillsBlock, buildAgentsBlock, buildMcpBlock } from "../context/prompt-builder.js";
import { discoverSkills, findSkill, type Skill } from "../context/skills.js";
import type { ChatMessage } from "../llm/llm.js";
import { formatWorkingMemory, memoryIsMeaningful, type WorkingMemory } from "../context/memory.js";

/** Compaction prompt fragment that preserves the working-memory ledger. */
export function memoryBlock(memory: WorkingMemory, taskNote?: string): { instruction: string; suffix: string } {
  if (!memoryIsMeaningful(memory)) return { instruction: "", suffix: "" };
  const ledger = formatWorkingMemory(memory);
  return {
    instruction: `\n\nWorking memory ledger accumulated so far (keep ALL of it in the summary):\n${ledger}`,
    suffix: `\n\n${ledger}${taskNote ?? ""}`,
  };
}

export interface BuildRunMessagesInput {
  config: AgentConfig;
  primaryDef: AgentDef | null;
  skills: Skill[];
  buildCmd: string;
  task: string;
  pendingContext: string[];
}

/** Build the first system/user message batch without changing prompt composition or order. */
export function buildRunMessages(input: BuildRunMessagesInput): ChatMessage[] {
  const { config, primaryDef, skills, buildCmd, task, pendingContext } = input;
  const skillsBlock = buildSkillsBlock(skills);
  const agentsGuideBlock = buildAgentGuideBlock(config.workdir, task);
  const repoMapBlock = config.repoMap === false ? "" : `\n\n${buildRepoMap(config.workdir)}`;
  const baseOverride = primaryDef?.prompt?.trim() ? primaryDef.prompt : undefined;
  return [
    {
      role: "system",
      content: buildSystemPrompt({
        workdir: config.workdir,
        buildCmd,
        envInfo: buildEnvInfo(config.workdir),
        skillsBlock,
        mcpBlock: buildMcpBlock(config),
        agentsGuideBlock,
        repoMapBlock,
        base: baseOverride,
        promptVersion: config.promptVersion,
      }) + buildAgentsBlock(discoverAgents(config.workdir), config.allowSubagents !== false),
    },
    ...pendingContext.map((content) => ({ role: "user" as const, content })),
    { role: "user", content: task },
  ];
}

/** Project/global skills plus the one-shot context staged by `/skill`. */
export class PromptContext {
  private skills: Skill[];
  private pendingContext: string[] = [];
  private pendingAllowedTools: string[] | null = null;

  constructor(private readonly workdir: string) {
    this.skills = discoverSkills(workdir);
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  reloadSkills(): void {
    this.skills = discoverSkills(this.workdir);
  }

  skillCount(): number {
    return this.skills.length;
  }

  stageSkill(name: string): { ok: boolean; message: string } {
    const skill = findSkill(this.workdir, name);
    if (!skill) {
      const names = this.skills.map((item) => item.name).join(", ");
      return { ok: false, message: `skill "${name}" not found${names ? ` — available: ${names}` : " — no skills discovered (try /skills)"}` };
    }
    this.pendingContext.push(`[User loaded skill "${skill.name}" — follow these instructions for the upcoming task]\n\n${skill.body}`);
    this.pendingAllowedTools = skill.allowedTools?.length ? skill.allowedTools : null;
    return { ok: true, message: `skill "${skill.name}" staged — it will apply to your next task` };
  }

  pendingTools(): string[] | null {
    return this.pendingAllowedTools;
  }

  clearPendingTools(): void {
    this.pendingAllowedTools = null;
  }

  takePendingContext(): string[] {
    const pending = this.pendingContext;
    this.pendingContext = [];
    return pending;
  }
}
