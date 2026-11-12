import type { AgentConfig } from "../config/config.js";
import { loadRcFile } from "../config/config.js";
import { parseCustomProviders, resolveProvider, splitProviderModel } from "../llm/provider-registry.js";
import type { ToolSpec } from "../llm/llm.js";
import type { ToolDiff, TodoItem } from "../tools/types.js";
import { findAgent, filterToolNamesForDef, type AgentDef } from "../context/agents.js";
import { consoleReporter } from "../io/console-reporter.js";
import type { Reporter } from "../io/reporter.js";

export interface AgentRunResult {
  success: boolean;
  steps: number;
  buildCmd: string | null;
  summary: string;
}

/**
 * Event schema version — bumped when AgentEvent changes shape.
 * v2 (additive): `run_start` gains schemaVersion/agent, `finish` gains
 * usage/verification, new event types: compaction, agent_start, agent_end,
 * tool_progress, question_request, queue, context.
 * Consumers on v1 ignore events/fields they don't know.
 */
export const EVENT_SCHEMA_VERSION = 2;

/** Verification outcome attached to `finish` — the completion gate's verdict. */
export interface VerificationInfo {
  /** true = build/tests pass; false = failing; null = nothing to verify. */
  ok: boolean | null;
  detail: string;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * Structured run events — emitted by the Agent so alternative frontends
 * (the `scoder serve` HTTP/SSE API) can render runs without touching the UI.
 */
export type AgentEvent =
  | {
      type: "run_start";
      task: string;
      model: string;
      provider: string;
      workdir: string;
      buildCmd: string;
      permission: string;
      schemaVersion?: number;
      agent?: string;
      /**
       * UI đã tự hiển thị task này (case `resume()` — transcript được restore
       * từ session). Reducer vẫn reset anchor per-run nhưng KHÔNG append thêm
       * dòng user, để task cũ không xuất hiện hai lần.
       */
      quiet?: boolean;
    }
  | { type: "step"; step: number; maxSteps: number }
  | { type: "llm_delta"; delta: string }
  /** I-05: reasoning/thinking stream delta (rendered dim, toggleable). */
  | { type: "llm_reasoning"; delta: string }
  | { type: "llm_usage"; usage: { input_tokens?: number; output_tokens?: number; cached_tokens?: number } }
  | { type: "tool_call"; step: number; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_output"; name: string; stream: "stdout" | "stderr"; delta: string }
  | {
      type: "tool_result";
      step: number;
      name: string;
      /** T6: tool_call id — correlate với event tool_call (parallel calls). */
      id: string;
      ok: boolean;
      output: string;
      /** Present for file-writing tools — unified diff of the change. */
      diff?: ToolDiff;
      /** T7: data URL khi tool đọc được ảnh — TUI render, không gửi LLM. */
      image?: string;
      /** Phase 5: true when output comes from a third-party MCP tool/resource. */
      untrusted?: boolean;
    }
  | { type: "build"; success: boolean; command: string; output: string }
  | { type: "todo"; items: TodoItem[] }
  /** User steering input accepted into the inbox (delivered at next step boundary). */
  | { type: "steer_queued"; mode: "steer" | "queue"; text: string }
  /** Steering batch delivered into the conversation at a step boundary. */
  | { type: "steer_delivered"; count: number }
  /** MCP connect/status line (routed through the event stream, not stderr). */
  | { type: "mcp_status"; line: string; server?: string; state?: string }
  /** Guardrail Engine kích hoạt một rule (dùng cho metrics/debug frontend). */
  | { type: "guardrail"; rule: string; action: string; reason: string }
  /** T-03: permission prompt — frontend renders a modal, answers via resolvePermission(). */
  | {
      type: "permission_request";
      id: string;
      kind: "shell" | "edit" | "mcp";
      label: string;
      command?: string;
      diff?: string;
      alwaysAllowPrefix?: string;
      timeoutSecs: number;
    }
  /** v2: LLM compaction actually ran (manual via /compact or auto in-loop). */
  | { type: "compaction"; tokensBefore: number; tokensAfter: number; manual?: boolean }
  /** v2: a subagent started (parentId links to the spawning agent). */
  | { type: "agent_start"; id: string; parentId?: string; name: string; description: string; model: string }
  /** v2: a subagent finished. */
  | { type: "agent_end"; id: string; ok: boolean; steps: number; summary: string }
  /** v2: progress of a long-running tool (e.g. MCP notifications/progress). */
  | { type: "tool_progress"; id: string; name: string; current?: number; total?: number; message?: string }
  /** v2: agent asks the user a question (ask_user tool). */
  | { type: "question_request"; id: string; question: string; options?: string[]; multiple?: boolean; timeoutSecs: number }
  /** v2: pending steering/queue depth — HUD badge source. */
  | { type: "queue"; pending: number; steering: number }
  /** v2: context window pressure after an LLM turn. */
  | { type: "context"; tokens: number; window: number; pct: number; compacted?: boolean }
  | { type: "finish"; success: boolean; steps: number; summary: string; usage?: UsageTotals; verification?: VerificationInfo }
  | { type: "error"; message: string };

export interface ResolvedPrimary {
  config: AgentConfig;
  def: AgentDef | null;
}

/**
 * v2 (3.1): resolve the primary agent for a run — apply its tool filter
 * inputs (permission/model/routing/temperature/steps/reasoning) onto the
 * runtime config BEFORE the client, ctx and tools are built.
 *
 * Resolution order for the model: rc/CLI routing[name] → def.model →
 * config.model (unchanged). Cross-provider "provider/model" refs rebuild the
 * provider resolution exactly like setModel does.
 *
 * Subagent defs passed programmatically (task runner) are applied as well —
 * the CLI/TUI layer is responsible for not offering subagent mode to users.
 */
export function resolvePrimaryConfig(config: AgentConfig, reporter: Reporter = config.reporter ?? consoleReporter): ResolvedPrimary {
  const name = (config.agent ?? "build").trim() || "build";
  let def = findAgent(config.workdir, name);
  if (!def) {
    reporter.warn(`agent "${name}" not found — falling back to the default build agent`);
    def = findAgent(config.workdir, "build");
    if (!def) return { config, def: null };
  }
  if (def.mode === "subagent") {
    // Programmatic subagents are fine; warn only when this came from user selection.
    reporter.warn(`agent "${def.name}" is a subagent — it runs via the task tool; using it as primary anyway (scoder --agent).`);
  }
  const out: AgentConfig = { ...config, agent: def.name };
  const modelRef = config.routing?.[def.name as "plan" | "build" | "review"] ?? def.model;
  if (modelRef && modelRef.trim()) {
    const [prov, id] = splitProviderModel(modelRef.trim());
    if (prov && prov !== out.provider) {
      const rcProviders = parseCustomProviders(loadRcFile(out.workdir).providers);
      const resolved = resolveProvider(prov, rcProviders);
      if ("def" in resolved) {
        out.provider = prov as "openai" | "anthropic";
        out.providerDef = resolved.def;
        out.model = id;
        out.baseUrl = resolved.def.baseUrl || out.baseUrl;
        out.apiKey = process.env[resolved.def.apiKeyEnv] || out.apiKey;
      } else {
        reporter.warn(`agent "${def.name}": provider "${prov}" not resolvable (${resolved.error}) — keeping ${out.model}`);
      }
    } else {
      out.model = id ?? modelRef.trim();
    }
  }
  if (def.temperature !== undefined) out.temperature = def.temperature;
  if (def.maxTokens !== undefined) out.maxTokens = def.maxTokens;
  if (def.reasoning) out.reasoning = def.reasoning;
  if (def.steps !== undefined && Number.isFinite(def.steps) && def.steps >= 1) out.maxSteps = Math.floor(def.steps);
  if (def.permission) out.permissionMode = def.permission;
  return { config: out, def };
}

/** Filter tool specs for the resolved def; warn about unknown whitelist names. */
export function applyToolFilter(specs: ToolSpec[], def: AgentDef | null, reporter: Reporter): ToolSpec[] {
  if (!def) return specs;
  const before = specs.length;
  const names = filterToolNamesForDef(specs.map((s) => s.function.name), def);
  if (def.tools?.length) {
    const known = new Set(specs.map((s) => s.function.name.toLowerCase()));
    const unknown = def.tools.filter((t) => !known.has(t.toLowerCase()) && !t.startsWith("mcp__"));
    if (unknown.length > 0) reporter.warn(`agent "${def.name}": unknown tools in definition dropped: ${unknown.join(", ")}`);
  }
  if (names.length === before) return specs;
  const allow = new Set(names);
  return specs.filter((s) => allow.has(s.function.name));
}

