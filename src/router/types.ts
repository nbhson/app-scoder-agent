/**
 * P2.2 Phase A (plan/P2-02-model-router.md) — router core types.
 * Pure module: no Ink, no I/O, imports only types from llm/. The RouterRuntime
 * plugs into the agent loop as ONE MORE `ProviderRuntimeContract`
 * implementation, so nothing above this module knows routing exists.
 */
import type { ProviderDef } from "../llm/provider-registry.js";

export type Tier = "small" | "large";

/**
 * One routable candidate, flattened from a P2.1 ref (`provider/model` or a
 * bare id resolved through `resolveModelRef`). `def === undefined` means the
 * ref resolved to the ACTIVE builtin (no rc provider involved).
 */
export interface RouterModel {
  /** Canonical ref used in the UI/audit: `provider/model`. */
  ref: string;
  tier: Tier;
  /** Bare model id sent to the provider. */
  model: string;
  /** Provider id (openai/anthropic when no custom provider). */
  provider: string;
  /** opencode `tool_call: false` → never used for turns that carry tools. */
  toolCall: boolean;
  contextWindow?: number;
  pricing?: { input: number; output: number };
  /** Resolved provider def (endpoint/key/kind) — set when a provider backs it. */
  def?: ProviderDef;
}

/** rc `router` block after validation (config.ts owns parsing, Phase B). */
export interface RouterSignals {
  smallMaxCtxTokens?: number;
  largeToolSchemaChars?: number;
}
export interface RouterRule {
  when: string;
  use: Tier;
}
export interface RouterEscalate {
  buildFails?: number;
  stickyMinSteps?: number;
}
export interface RouterJudgeConfig {
  model: string;
  scope?: "gray" | "first" | "always";
  timeoutMs?: number;
  minConfidence?: number;
}
export interface RouterConfig {
  enabled?: boolean;
  fallback?: string;
  tiers?: { small?: string[]; large?: string[] };
  signals?: RouterSignals;
  rules?: RouterRule[];
  escalate?: RouterEscalate;
  /** null/undefined (default) → 3-layer pipeline, ZERO extra requests. */
  judge?: RouterJudgeConfig | null;
  /** legacy key `router.classifier: true` — config.ts maps to judge + warns. */
  classifier?: boolean;
}

/** Everything resolved + defaulted — what the runtime consumes. */
export interface ResolvedRouterConfig {
  signals: { smallMaxCtxTokens: number; largeToolSchemaChars: number };
  rules: RouterRule[];
  escalate: { buildFails: number; stickyMinSteps: number };
  judge?: RouterJudgeConfig;
}

/** Turn-level context fed to the classifier (Phase B wires the real one). */
export interface TurnContext {
  /** 1-based step in the run loop; 0 = unknown. */
  step: number;
  maxSteps: number;
  /** Coarse phase label: explore | edit | build | verify | plan | self-review | … */
  phase: string | null;
  /** Consecutive failing build checks (0 when the last build passed). */
  buildFailStreak: number;
  /** Doom-loop / guardrail trips in the recent window. */
  guardrailStreak: number;
  /** Consecutive tool-argument repair rounds. */
  toolArgsRepairStreak: number;
}

export const IDLE_TURN_CONTEXT: TurnContext = {
  step: 0,
  maxSteps: 0,
  phase: null,
  buildFailStreak: 0,
  guardrailStreak: 0,
  toolArgsRepairStreak: 0,
};

/** Emitted per routed turn (→ AgentEvent `route_decision` → JSONL → TUI). */
export interface RouteDecision {
  step: number;
  tier: Tier;
  /** Canonical `provider/model` ref chosen for this turn. */
  ref: string;
  provider: string;
  model: string;
  reason: string;
  /** Layer signals for the audit panel (score, tokens, schema chars, …). */
  signals: Record<string, number | string>;
  /** True when the ref differs from the previous turn's (client flipped). */
  switched: boolean;
  /** L4 verdict when a judge ran (Phase E). */
  judge?: {
    model: string;
    confidence: number;
    ms: number;
    tokens: number;
    verdict: "accept" | "reject-hallucinated" | "reject-confidence" | "timeout" | "fallback";
  };
}

/** Decision sink type (Agent injects `emit` without importing the router module). */
export type RouteDecisionListener = (d: RouteDecision) => void;

/** Judge surface (Phase E implements; the runtime only knows this shape). */
export interface JudgeVerdict {
  tier: Tier | null;
  ref: string | null;
  confidence: number;
  reason: string;
  ms: number;
  tokens: number;
}
export interface Judge {
  /** Must never throw — errors come back as a null-ref verdict. */
  judge(ctx: TurnContext, candidates: RouterModel[], base: { tier: Tier; reason: string }): Promise<JudgeVerdict>;
}

/** Defaults from plan §2/§4 — thresholds are intentionally cheap-biased. */
export const ROUTER_DEFAULTS = {
  smallMaxCtxTokens: 16_000,
  largeToolSchemaChars: 30_000,
  buildFails: 2,
  stickyMinSteps: 2,
};

/** ~4 chars/token heuristic — same ballpark as the agent's estimateTokens. */
export function estimateHistoryTokens(messages: { content: string | null; tool_calls?: { name: string; arguments: string }[] }[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    for (const tc of m.tool_calls ?? []) chars += tc.name.length + tc.arguments.length;
  }
  return Math.ceil(chars / 4);
}
