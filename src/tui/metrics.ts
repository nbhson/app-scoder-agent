/**
 * Pure run-metric helpers — the single source for cost / context-pressure
 * math, shared by Sidebar METRICS (sidebar.tsx) and the compact StatusBar
 * fallback shown when the sidebar is hidden (narrow terminals, A6).
 *
 * Kept framework-free: unit-testable without rendering.
 */
import { contextWindowFor } from "../llm/model-catalog.js";
import { resolveModelPricing } from "../shared/constants.js";
import type { TuiState } from "./state.js";

/** USD cost of the run so far (input+output at catalog pricing; cache-free). */
export function runCostUsd(state: TuiState): number {
  const pricing = resolveModelPricing(state.model);
  return (
    (state.usage.inputTokens / 1_000_000) * pricing.input +
    (state.usage.outputTokens / 1_000_000) * pricing.output
  );
}

/** Current context-window pressure in %, or null when nothing reported yet.
 *
 * Prefers the agent's live `context` event; falls back to cumulative input
 * tokens / catalog window BEFORE the first turn has reported (mirrors the
 * sidebar METRICS logic exactly). */
export function ctxPctOf(state: TuiState): number | null {
  if (state.context?.pct != null) return state.context.pct;
  const hasUsage = state.usage.calls > 0;
  const tokens = state.context?.tokens ?? (hasUsage ? state.usage.inputTokens : null);
  const window = state.context?.window ?? contextWindowFor(state.provider, state.model);
  if (tokens == null || !(window > 0)) return null;
  return Math.min(100, Math.round((tokens / window) * 100));
}

/** One-line compact metrics for the StatusBar when the sidebar is hidden:
 *  `ctx 41% · $0.12`. Null until there is something to show. */
export function compactMetrics(state: TuiState): string | null {
  const pct = ctxPctOf(state);
  const cost = runCostUsd(state);
  const parts: string[] = [];
  if (pct != null) parts.push(`ctx ${pct}%`);
  if (cost > 0) parts.push(`$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Steering/queue badge text: `⇢ 2` when messages await delivery, else null. */
export function queueBadge(state: TuiState): string | null {
  return state.queue.pending > 0 ? `⇢ ${state.queue.pending}` : null;
}
