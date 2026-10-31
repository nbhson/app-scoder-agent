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
import { resolveModelPricing, type ModelPricing } from "./constants.js";

/** One `llm_usage` event extracted from a JSONL log. */
export interface UsageEvent {
  ts?: string;
  sessionId: string;
  model: string;
  provider?: string;
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

