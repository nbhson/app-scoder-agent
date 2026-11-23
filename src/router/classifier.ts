/**
 * P2.2 Phase A — L1 heuristic classifier + L2 rule engine (plan/P2-02 §2, §5).
 * Pure functions, zero cost, always run. L3 hysteresis lives in hysteresis.ts;
 * the runtime composes: pin > L2 rules > L4 judge > L1 score (+ L3 post-run).
 */
import type { ResolvedRouterConfig, RouterRule, Tier, TurnContext } from "./types.js";

export interface ClassifySignals {
  /** est. history size in tokens (chars/4). */
  estTokens: number;
  /** JSON size of the tool schemas shipped this turn. */
  toolSchemaChars: number;
  toolCount: number;
  /** True when the tail of the history is tool results (a wrap-up/answer turn). */
  endsInToolResults: boolean;
}

export interface ClassifyResult {
  tier: Tier;
  /** Score > threshold → large; |score| within the gray band → gray. */
  gray: boolean;
  score: number;
  reason: string;
  signals: Record<string, number | string>;
}

/**
 * Gray band: |score| ≤ 1. Without a judge the band resolves ASYMMETRICALLY
 * to large (§4b): a small model botching a big task burns 5–10 fail-loop
 * steps — far dearer than the few cents of the opposite mistake.
 */
export const GRAY_BAND = 1;

/** Derive a coarse phase label from the last assistant tool call (core-side,
 *  no TUI import). run-loop wiring (Phase B) may pass a richer value. */
export function phaseFromToolCall(name: string | undefined | null): string | null {
  if (!name) return null;
  if (/^(read_file|glob|grep|list|web_search|web_fetch|skills_list|todo)$/i.test(name)) return "explore";
  if (/^(edit_file|write_file|apply_patch)$/i.test(name)) return "edit";
  if (name === "run_command") return "build";
  if (name === "finish") return "verify";
  return "tool";
}

/** Compare one rule clause: numeric keys use all four ops, strings ==/!=. */
function compareClause(actual: number | string, op: string, rawExpected: string): boolean {
  if (typeof actual === "number") {
    const expected = Number(rawExpected);
    if (!Number.isFinite(expected)) return false;
    switch (op) {
      case "==":
        return actual === expected;
      case "!=":
        return actual !== expected;
      case ">=":
        return actual >= expected;
      default:
        return actual <= expected;
    }
  }
  const eq = actual.toLowerCase() === rawExpected.toLowerCase();
  return op === "==" ? eq : op === "!=" ? !eq : false;
}

/** Tiny rule DSL: `"<key> <op> <value>"` with op ∈ == != >= <= ;
 *  key ∈ phase|step|tokens|tools. Returns true when the clause fires. */
export function matchRule(rule: RouterRule, ctx: TurnContext, sig: ClassifySignals): boolean {
  const m = /^\s*(\w+)\s*(==|!=|>=|<=)\s*(\S.*?)\s*$/.exec(rule.when ?? "");
  if (!m) return false;
  const [, key, op, rawVal] = m;
  const actual =
    key === "phase" ? (ctx.phase ?? "") : key === "step" ? ctx.step : key === "tokens" ? sig.estTokens : key === "tools" ? sig.toolCount : null;
  if (actual === null) return false;
  return compareClause(actual, op, rawVal);
}

/** L2 — first matching rule wins; reason names the exact `when` clause. */
export function applyRules(
  rules: RouterRule[],
  ctx: TurnContext,
  sig: ClassifySignals,
): { tier: Tier; reason: string } | null {
  for (const r of rules) {
    if (r.use !== "small" && r.use !== "large") continue;
    if (matchRule(r, ctx, sig)) return { tier: r.use, reason: `rule: ${r.when}` };
  }
  return null;
}

/**
 * L1 — weighted signals (plan §2). Positive score leans LARGE.
 * Hard triggers (build-fail lock, doom-loop) are handled by hysteresis,
 * not here — this function only reads the CURRENT turn's material.
 */
export function classify(sig: ClassifySignals, ctx: TurnContext, cfg: ResolvedRouterConfig): ClassifyResult {
  let score = 0;
  const reasons: string[] = [];

  if (sig.estTokens >= cfg.signals.smallMaxCtxTokens) {
    score += 1;
    reasons.push(`ctx ${Math.round(sig.estTokens / 1000)}k`);
  }
  const phase = (ctx.phase ?? "").toLowerCase();
  if (["edit", "build", "verify", "self-review", "plan-final"].includes(phase)) {
    score += 2;
    reasons.push(`phase:${phase}`);
  } else if (phase === "explore") {
    score -= 1;
    reasons.push("phase:explore");
  }
  if (sig.toolSchemaChars > cfg.signals.largeToolSchemaChars) {
    score += 1;
    reasons.push(`tools ${sig.toolCount}`);
  }
  if (ctx.step === 1 && ctx.maxSteps > 1) {
    score += 1;
    reasons.push("plan step");
  }
  if (ctx.maxSteps > 2 && ctx.step >= ctx.maxSteps - 1) {
    score += 1;
    reasons.push("wrap-up");
  }
  if (sig.endsInToolResults && sig.toolCount > 0) {
    score += 1;
    reasons.push("synthesis");
  }
  const tier: Tier = score > 0 ? "large" : "small";
  const gray = Math.abs(score) <= GRAY_BAND;
  return {
    tier,
    gray,
    score,
    reason: reasons.length ? reasons.join(" + ") : "flat history",
    signals: {
      score,
      estTokens: sig.estTokens,
      toolSchemaChars: sig.toolSchemaChars,
      toolCount: sig.toolCount,
      phase: phase || "-",
    },
  };
}
