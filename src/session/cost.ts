/**
 * Usage & cost tracking (enterprise feature).
 *
 * Every LLM call writes an `llm_usage` event into the session JSONL log:
 *   { ts, type: "llm_usage", model, provider, usage: { input_tokens, output_tokens, cached_tokens } }
 *
 * `scoder cost` reads those logs and aggregates tokens + estimated cost.
 * All logic here is pure/filesystem-only so it stays unit-testable.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveModelPricing, type ModelPricing } from "../shared/constants.js";

/** One `llm_usage` event extracted from a JSONL log. */
export interface UsageEvent {
  ts?: string;
  sessionId: string;
  model: string;
  provider?: string;
  /** P2.2: router attribution — absent when the router was off (v1 logs). */
  ref?: string;
  tier?: "small" | "large";
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface UsageAggregate {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** estimated cost in USD */
  costUsd: number;
}

/** Extract `llm_usage` events from a list of raw log events. */
export function extractUsageEvents(sessionId: string, events: Array<Record<string, unknown>>): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (const ev of events) {
    if (ev.type !== "llm_usage") continue;
    const usage = (ev.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    out.push({
      ts: typeof ev.ts === "string" ? ev.ts : undefined,
      sessionId,
      model: typeof ev.model === "string" ? ev.model : "unknown",
      provider: typeof ev.provider === "string" ? ev.provider : undefined,
      // P2.2: optional router attribution (absent in pre-router logs).
      ref: typeof ev.ref === "string" ? ev.ref : undefined,
      tier: ev.tier === "small" || ev.tier === "large" ? ev.tier : undefined,
      inputTokens: num(usage.input_tokens ?? usage.prompt_tokens),
      outputTokens: num(usage.output_tokens ?? usage.completion_tokens),
      cachedTokens: num(usage.cached_tokens),
    });
  }
  return out;
}

/** Cost of one usage event in USD (cached tokens are billed like input tokens here — provider-specific discounts are approximated by the price table). */
export function estimateEventCost(ev: UsageEvent, overrides: Record<string, ModelPricing> = {}): number {
  const p = resolveModelPricing(ev.model, overrides);
  return (ev.inputTokens / 1_000_000) * p.input + (ev.outputTokens / 1_000_000) * p.output;
}

/** Aggregate usage events into totals + estimated cost. */
export function aggregateUsage(events: UsageEvent[], overrides: Record<string, ModelPricing> = {}): UsageAggregate {
  const agg: UsageAggregate = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
  for (const ev of events) {
    agg.calls += 1;
    agg.inputTokens += ev.inputTokens;
    agg.outputTokens += ev.outputTokens;
    agg.cachedTokens += ev.cachedTokens;
    agg.costUsd += estimateEventCost(ev, overrides);
  }
  agg.costUsd = Math.round(agg.costUsd * 10_000) / 10_000; // round to $0.0001
  return agg;
}

/** Parse a JSONL log file into raw events (null if missing/unreadable). */
export function readJsonlLog(path: string): Array<Record<string, unknown>> | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const events: Array<Record<string, unknown>> = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

/** List all session log files, newest id first (ids sort chronologically). */
export function listLogSessions(workdir: string): string[] {
  const dir = resolve(workdir, ".scoder/logs");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Load all usage events of a single session (or [] if no log). */
export function loadSessionUsage(workdir: string, sessionId: string): UsageEvent[] {
  const path = resolve(workdir, ".scoder/logs", `${sessionId}.jsonl`);
  const events = readJsonlLog(path);
  return events ? extractUsageEvents(sessionId, events) : [];
}

// ── P2.2: router decisions from JSONL (`route_decision` events) ─────────────

/** One `route_decision` event (emitted only in AUTO mode). */
export interface RouteEvent {
  ts?: string;
  sessionId: string;
  step: number;
  tier: "small" | "large";
  ref: string;
  model: string;
  provider?: string;
  reason: string;
  switched: boolean;
  judgeVerdict?: string;
}

/** Extract `route_decision` events from raw log lines (empty if no router). */
export function extractRouteEvents(sessionId: string, events: Array<Record<string, unknown>>): RouteEvent[] {
  const out: RouteEvent[] = [];
  for (const ev of events) {
    if (ev.type !== "route_decision") continue;
    if (ev.tier !== "small" && ev.tier !== "large") continue;
    const judge = (ev.judge ?? {}) as Record<string, unknown>;
    out.push({
      ts: typeof ev.ts === "string" ? ev.ts : undefined,
      sessionId,
      step: typeof ev.step === "number" ? ev.step : 0,
      tier: ev.tier,
      ref: typeof ev.ref === "string" ? ev.ref : "unknown",
      model: typeof ev.model === "string" ? ev.model : "unknown",
      provider: typeof ev.provider === "string" ? ev.provider : undefined,
      reason: typeof ev.reason === "string" ? ev.reason : "",
      switched: ev.switched === true,
      judgeVerdict: typeof judge.verdict === "string" ? judge.verdict : undefined,
    });
  }
  return out;
}

/** Per-model breakdown of usage events (keyed by ref when present, else model id). */
export interface ModelBreakdown {
  key: string;
  tier?: "small" | "large";
  aggregate: UsageAggregate;
}

/** Group usage events by model (ref if the router attributed it, else model id). */
export function breakdownByModel(events: UsageEvent[], overrides: Record<string, ModelPricing> = {}): ModelBreakdown[] {
  const byKey = new Map<string, { tier?: "small" | "large"; evs: UsageEvent[] }>();
  for (const ev of events) {
    const key = ev.ref ?? ev.model;
    const bucket = byKey.get(key) ?? { tier: ev.tier, evs: [] };
    bucket.evs.push(ev);
    byKey.set(key, bucket);
  }
  return [...byKey.entries()]
    .map(([key, { tier, evs }]) => ({ key, tier, aggregate: aggregateUsage(evs, overrides) }))
    .sort((a, b) => b.aggregate.costUsd - a.aggregate.costUsd);
}

/** Render a per-model cost table (used by `scoder cost --router`, plan §6). */
export function formatModelBreakdown(breaks: ModelBreakdown[]): string {
  if (breaks.length === 0) return "No routed usage recorded.";
  const lines = ["  MODEL  calls   in        out       cost"];
  for (const b of breaks) {
    const t = b.tier ? ` (${b.tier})` : "";
    lines.push(
      `  ${b.key}${t}  ${b.aggregate.calls}  ${b.aggregate.inputTokens.toLocaleString("en-US")}  ` +
        `${b.aggregate.outputTokens.toLocaleString("en-US")}  $${b.aggregate.costUsd.toFixed(4)}`,
    );
  }
  return lines.join("\n");
}

// ── Session metrics (latency / success / guardrails) ────────────────────────

export interface SessionMetrics {
  /** Số bước agent đã chạy (event type=step). */
  stepCount: number;
  /** Tổng thời gian phần LLM của các bước (ms) — từ durationMs của event step. */
  stepLatencyTotalMs: number;
  /** Bước LLM chậm nhất (ms). */
  stepLatencyMaxMs: number;
  /** Số tool call đã thực thi. */
  toolCallCount: number;
  /** Số lần Guardrail Engine kích hoạt (mọi rule cộng lại). */
  guardrailCount: number;
  /** Kết quả cuối (event finish) — null nếu session chưa kết thúc. */
  success: boolean | null;
}

const EMPTY_METRICS: SessionMetrics = {
  stepCount: 0,
  stepLatencyTotalMs: 0,
  stepLatencyMaxMs: 0,
  toolCallCount: 0,
  guardrailCount: 0,
  success: null,
};

/** Trích metrics hiệu năng từ raw JSONL events của một session. */
export function extractSessionMetrics(events: Array<Record<string, unknown>>): SessionMetrics {
  const m: SessionMetrics = { ...EMPTY_METRICS };
  for (const ev of events) {
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    switch (ev.type) {
      case "step":
        m.stepCount += 1;
        m.stepLatencyTotalMs += num(ev.durationMs);
        m.stepLatencyMaxMs = Math.max(m.stepLatencyMaxMs, num(ev.durationMs));
        break;
      case "tool":
        m.toolCallCount += 1;
        break;
      case "guardrail":
        m.guardrailCount += 1;
        break;
      case "finish":
        m.success = ev.success === true;
        break;
    }
  }
  return m;
}

export interface SessionCost {
  sessionId: string;
  aggregate: UsageAggregate;
  /** Metrics hiệu năng (latency/success/guardrails) từ cùng log JSONL. */
  metrics: SessionMetrics;
}

/**
 * Collect usage for a selection of sessions:
 *  - explicit id    -> that session
 *  - "last n"       -> n most recent session logs
 *  - all            -> every session log in the workdir
 */
export function collectUsage(
  workdir: string,
  opts: { sessionId?: string; last?: number; pricingOverrides?: Record<string, ModelPricing> } = {},
): SessionCost[] {
  let ids: string[];
  if (opts.sessionId) {
    ids = [opts.sessionId];
  } else if (typeof opts.last === "number") {
    const all = listLogSessions(workdir);
    ids = all.slice(0, Math.max(0, opts.last));
  } else {
    ids = listLogSessions(workdir);
  }
  return ids.map((id) => {
    const events = readJsonlLog(resolve(workdir, ".scoder/logs", `${id}.jsonl`)) ?? [];
    return {
      sessionId: id,
      aggregate: aggregateUsage(extractUsageEvents(id, events), opts.pricingOverrides),
      metrics: extractSessionMetrics(events),
    };
  });
}

/** Render a human-readable cost report (also used by tests to assert output). */
export function formatCostReport(sessionCosts: SessionCost[]): string {
  if (sessionCosts.length === 0) {
    return "No LLM usage recorded. Run with --log-file (or SCODER_LOG_FILE=1) to record usage.";
  }

  const grand: UsageAggregate = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
  const lines: string[] = ["COST REPORT"];
  let successes = 0;
  let finished = 0;
  for (const sc of sessionCosts) {
    const a = sc.aggregate;
    const mx = sc.metrics;
    grand.calls += a.calls;
    grand.inputTokens += a.inputTokens;
    grand.outputTokens += a.outputTokens;
    grand.cachedTokens += a.cachedTokens;
    grand.costUsd += a.costUsd;
    if (mx.success !== null) {
      finished += 1;
      if (mx.success) successes += 1;
    }
    const avgS = mx.stepCount > 0 ? (mx.stepLatencyTotalMs / mx.stepCount / 1000).toFixed(1) : null;
    lines.push(
      `  ${sc.sessionId}  calls=${a.calls}  in=${a.inputTokens.toLocaleString("en-US")}  out=${a.outputTokens.toLocaleString("en-US")}  cached=${a.cachedTokens.toLocaleString("en-US")}  cost≈$${a.costUsd.toFixed(4)}` +
        (mx.stepCount > 0
          ? `  |  steps=${mx.stepCount}${avgS ? ` llm-avg=${avgS}s` : ""} tools=${mx.toolCallCount} guardrails=${mx.guardrailCount}` +
            (mx.success !== null ? ` ${mx.success ? "✓success" : "✗failed"}` : "")
          : ""),
    );
  }
  grand.costUsd = Math.round(grand.costUsd * 10_000) / 10_000;
  lines.push(
    `TOTAL (${sessionCosts.length} session(s))  calls=${grand.calls}  in=${grand.inputTokens.toLocaleString("en-US")}  out=${grand.outputTokens.toLocaleString("en-US")}  cached=${grand.cachedTokens.toLocaleString("en-US")}  cost≈$${grand.costUsd.toFixed(4)}` +
      (finished > 0 ? `  |  success-rate=${successes}/${finished}` : ""),
  );
  return lines.join("\n");
}

/** Join a path under the workdir's log dir (exported for tests). */
export function logFilePath(workdir: string, sessionId: string): string {
  return join(workdir, ".scoder/logs", `${sessionId}.jsonl`);
}

/**
 * P2.2 `scoder cost --router`: collect per-model breakdown, route-decision
 * counts and a "would have cost at large" savings estimate for the selection.
 */
export interface RouterReport {
  models: ModelBreakdown[];
  decisions: number;
  small: number;
  large: number;
  switched: number;
  judge: number;
  /** actual cost of routed calls */
  actualUsd: number;
  /** same tokens priced at the most expensive large model actually used */
  hypotheticalUsd: number;
}

const EMPTY_ROUTER_REPORT: Omit<RouterReport, "models"> = {
  decisions: 0,
  small: 0,
  large: 0,
  switched: 0,
  judge: 0,
  actualUsd: 0,
  hypotheticalUsd: 0,
};

export function buildRouterReport(
  workdir: string,
  opts: { sessionId?: string; last?: number; pricingOverrides?: Record<string, ModelPricing> } = {},
): RouterReport {
  const ids = resolveSessionIds(workdir, opts);
  const allUsage: UsageEvent[] = [];
  const allRoutes: RouteEvent[] = [];
  for (const id of ids) {
    const events = readJsonlLog(resolve(workdir, ".scoder/logs", `${id}.jsonl`)) ?? [];
    allUsage.push(...extractUsageEvents(id, events));
    allRoutes.push(...extractRouteEvents(id, events));
  }
  const models = breakdownByModel(allUsage, opts.pricingOverrides);
  if (allRoutes.length === 0) return { models, ...EMPTY_ROUTER_REPORT };

  let small = 0;
  let large = 0;
  let switched = 0;
  let judge = 0;
  for (const r of allRoutes) {
    if (r.tier === "small") small++;
    else large++;
    if (r.switched) switched++;
    if (r.judgeVerdict) judge++;
  }
  // The dearest large model actually used becomes the "always-large" baseline.
  const worst = pickWorstPriced(models.filter((m) => m.tier === "large"), opts.pricingOverrides);
  const routed = allUsage.filter((u) => u.tier !== undefined);
  const actualUsd = aggregateUsage(routed, opts.pricingOverrides).costUsd;
  let hypotheticalUsd = 0;
  if (worst) {
    for (const u of routed) {
      hypotheticalUsd += (u.inputTokens / 1_000_000) * worst.input + (u.outputTokens / 1_000_000) * worst.output;
    }
  }
  return {
    models,
    decisions: allRoutes.length,
    small,
    large,
    switched,
    judge,
    actualUsd: Math.round(actualUsd * 10_000) / 10_000,
    hypotheticalUsd: Math.round(hypotheticalUsd * 10_000) / 10_000,
  };
}

function resolveSessionIds(
  workdir: string,
  opts: { sessionId?: string; last?: number },
): string[] {
  if (opts.sessionId) return [opts.sessionId];
  const all = listLogSessions(workdir);
  if (typeof opts.last === "number") return all.slice(0, Math.max(0, opts.last));
  return all;
}

function pickWorstPriced(largeModels: ModelBreakdown[], overrides: Record<string, ModelPricing> = {}): ModelPricing | null {
  let worst: ModelPricing | null = null;
  for (const m of largeModels) {
    const p = resolveModelPricing(m.key.split("/").pop() ?? m.key, overrides);
    if (!worst || p.output > worst.output) worst = p;
  }
  return worst;
}

/** Render the `--router` report block (plan §6). */
export function formatRouterReport(r: RouterReport): string {
  if (r.decisions === 0) {
    return "ROUTER: no route_decision events in these sessions (router off or PINNED mode).";
  }
  const saved = r.hypotheticalUsd - r.actualUsd;
  const pct = r.hypotheticalUsd > 0 ? Math.round((saved / r.hypotheticalUsd) * 100) : 0;
  return [
    `ROUTER (${r.decisions} decisions)  small=${r.small}  large=${r.large}  switches=${r.switched}  judge=${r.judge}`,
    formatModelBreakdown(r.models),
    `  routed cost≈$${r.actualUsd.toFixed(4)}  always-large≈$${r.hypotheticalUsd.toFixed(4)}  saved≈$${saved.toFixed(4)} (${pct}%)`,
  ].join("\n");
}

