/**
 * P2.2 Phase A — L3 hysteresis (plan/P2-02 §4). Outcome feedback that
 * STABILISES L1/L2 decisions: build-fail lock, sticky minimum steps,
 * clean-streak demotion, prompt-cache affinity (keep the ref while the
 * tier is unchanged).
 */
import type { Tier, TurnContext } from "./types.js";

export interface HysteresisState {
  tier: Tier | null;
  /** Steps since the last actual tier flip (sticky window counter). */
  stepsSinceSwitch: number;
  /** Consecutive clean steps while on large (no build fail, no guardrail). */
  cleanSteps: number;
}

export function initialHysteresis(tier: Tier | null = null): HysteresisState {
  return { tier, stepsSinceSwitch: Number.MAX_SAFE_INTEGER, cleanSteps: 0 };
}

export interface HysteresisResult {
  tier: Tier;
  /** Layer text when L3 overrode the L1/L2 tier ("" when it passed through). */
  override: string;
  /** True when the tier actually flipped this step. */
  flipped: boolean;
}

/** Hard escalation trigger (small→large, unconditional, beats sticky). */
function escalateReason(ctx: TurnContext, cfg: { buildFails: number }): string | null {
  if (ctx.buildFailStreak >= cfg.buildFails) return `escalate: build fail ×${ctx.buildFailStreak}`;
  if (ctx.guardrailStreak >= 2) return `escalate: guardrail ×${ctx.guardrailStreak}`;
  if (ctx.toolArgsRepairStreak >= 2) return `escalate: tool-args repair ×${ctx.toolArgsRepairStreak}`;
  return null;
}

/** Why a large→small demotion may not happen yet ("" = free to demote). */
function holdLargeReason(state: HysteresisState, ctx: TurnContext): string | null {
  if (ctx.buildFailStreak > 0) return `hold large: build failing (×${ctx.buildFailStreak})`;
  const cleanEnough = state.cleanSteps >= 3;
  const phaseSafe = ctx.phase !== "edit" && ctx.phase !== "build" && ctx.phase !== "verify";
  if (cleanEnough && phaseSafe) return null;
  return `hold large: ${cleanEnough ? "phase still heavy" : "clean streak < 3"}`;
}

/**
 * Decide the EFFECTIVE tier for this turn given the last L1/L2/L4 preference.
 * Escalation is unconditional; demotion needs 3 clean steps + a light phase;
 * any flip honours `stickyMinSteps` (escalations excepted — safety beats
 * stability).
 */
export function hysteresisDecide(
  wanted: Tier,
  state: HysteresisState,
  ctx: TurnContext,
  cfg: { buildFails: number; stickyMinSteps: number },
): { result: HysteresisResult; state: HysteresisState } {
  const prev = state.tier;
  let next = wanted;
  let override = "";

  const esc = escalateReason(ctx, cfg);
  if (esc && prev !== "large") {
    next = "large";
    override = esc;
  } else if (prev === "large" && next === "small") {
    const hold = holdLargeReason(state, ctx);
    if (hold) {
      next = "large";
      override = hold;
    }
  }

  // Sticky: refuse flips younger than stickyMinSteps — cache prefix + output
  // style churn costs more than a marginally wrong tier. Hard escalations
  // always punch through.
  const hardEscalated = esc !== null && next === "large";
  if (prev !== null && next !== prev && !hardEscalated && state.stepsSinceSwitch < cfg.stickyMinSteps) {
    next = prev;
    override = `sticky: hold ${prev} (${state.stepsSinceSwitch}/${cfg.stickyMinSteps})`;
  }

  return { result: { tier: next, override, flipped: prev !== null && next !== prev }, state: advanceState(prev, next, state, ctx) };
}

/** Roll the counters one turn: switch age + clean-step streak. */
function advanceState(
  prev: Tier | null,
  next: Tier,
  state: HysteresisState,
  ctx: TurnContext,
): HysteresisState {
  const flipped = prev !== null && next !== prev;
  const clean = ctx.buildFailStreak === 0 && ctx.guardrailStreak === 0 && ctx.toolArgsRepairStreak === 0;
  return {
    tier: next,
    stepsSinceSwitch: flipped || prev === null ? 0 : state.stepsSinceSwitch + 1,
    cleanSteps: next === "large" && clean ? state.cleanSteps + 1 : next === "large" ? 0 : state.cleanSteps,
  };
}
