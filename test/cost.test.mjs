/**
 * Unit tests cho cost tracking (src/cost.ts + constants.ts + llm_usage events).
 * Chạy: node --test test/cost.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractUsageEvents,
  estimateEventCost,
  aggregateUsage,
  collectUsage,
  formatCostReport,
  listLogSessions,
  logFilePath,
} from "../dist/cost.js";
import { resolveModelPricing, DEFAULT_MODEL_PRICING } from "../dist/constants.js";

const TMP = join("/tmp", `scoder-cost-test-${process.pid}`);

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, ".scoder/logs"), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Write a fake session JSONL log with llm_usage events. */
function writeLog(sessionId, events) {
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(TMP, ".scoder/logs", `${sessionId}.jsonl`), lines, "utf8");
}

describe("resolveModelPricing — bảng giá theo prefix", () => {
  it("khớp prefix: gpt-4o-mini-* dùng giá gpt-4o-mini", () => {
    const p = resolveModelPricing("gpt-4o-mini-2024-07-18");
    assert.equal(p.input, 0.15);
    assert.equal(p.output, 0.6);
  });

  it("prefix dài hơn thắng: gpt-4o-mini trước gpt-4o", () => {
    const p = resolveModelPricing("gpt-4o-mini");
    assert.equal(p.input, 0.15, "không được dùng giá gpt-4o (2.5)");
  });

  it("model không rõ -> DEFAULT_MODEL_PRICING (không phải 0)", () => {
    const p = resolveModelPricing("totally-unknown-model");
    assert.deepEqual(p, DEFAULT_MODEL_PRICING);
  });

  it("override qua config thắng bảng mặc định", () => {
    const p = resolveModelPricing("gpt-4o-mini", { "gpt-4o-mini": { input: 1, output: 2 } });
    assert.equal(p.input, 1);
    assert.equal(p.output, 2);
  });

  it("override chỉ áp dụng cho model được khai báo", () => {
    const p = resolveModelPricing("claude-sonnet-4-5", { "gpt-4o-mini": { input: 1, output: 2 } });
    assert.equal(p.input, 3); // bảng mặc định claude-sonnet-4
  });
});

describe("extractUsageEvents — parse event llm_usage", () => {
  it("lấy input/output/cached từ event llm_usage", () => {
    const evs = extractUsageEvents("s1", [
      { ts: "2026-01-01T00:00:00Z", type: "llm_usage", model: "gpt-4o-mini", provider: "openai", usage: { input_tokens: 100, output_tokens: 50, cached_tokens: 20 } },
      { ts: "2026-01-01T00:00:01Z", type: "step", step: 1 },
      { ts: "2026-01-01T00:00:02Z", type: "finish", success: true },
    ]);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].model, "gpt-4o-mini");
    assert.equal(evs[0].inputTokens, 100);
    assert.equal(evs[0].outputTokens, 50);
    assert.equal(evs[0].cachedTokens, 20);
    assert.equal(evs[0].sessionId, "s1");
  });

  it("fallback tên field OpenAI (prompt_tokens/completion_tokens)", () => {
    const evs = extractUsageEvents("s1", [
      { type: "llm_usage", model: "m", usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    assert.equal(evs[0].inputTokens, 10);
    assert.equal(evs[0].outputTokens, 5);
    assert.equal(evs[0].cachedTokens, 0);
  });

  it("model thiếu / usage sai kiểu -> giá trị an toàn, không crash", () => {
    const evs = extractUsageEvents("s1", [
      { type: "llm_usage", usage: null },
      { type: "llm_usage", model: 42, usage: { input_tokens: "x" } },
      "garbage",
    ]);
    assert.equal(evs.length, 2);
    assert.equal(evs[0].model, "unknown");
    assert.equal(evs[0].inputTokens, 0);
    assert.equal(evs[1].inputTokens, 0);
  });
});

describe("estimateEventCost / aggregateUsage", () => {
  it("cost = in/1M*priceIn + out/1M*priceOut", () => {
    const ev = { sessionId: "s", model: "gpt-4o-mini", inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0 };
    // gpt-4o-mini: input 0.15, output 0.6
    assert.ok(Math.abs(estimateEventCost(ev) - 0.75) < 1e-9);
  });

  it("aggregateUsage cộng dồn nhiều event", () => {
    const evs = [
      { sessionId: "s", model: "gpt-4o-mini", inputTokens: 1000, outputTokens: 500, cachedTokens: 100 },
      { sessionId: "s", model: "gpt-4o-mini", inputTokens: 2000, outputTokens: 1000, cachedTokens: 0 },
    ];
    const agg = aggregateUsage(evs);
    assert.equal(agg.calls, 2);
    assert.equal(agg.inputTokens, 3000);
    assert.equal(agg.outputTokens, 1500);
    assert.equal(agg.cachedTokens, 100);
    assert.ok(agg.costUsd > 0);
  });

  it("aggregateUsage rỗng -> 0 hết", () => {
    assert.deepEqual(aggregateUsage([]), { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 });
  });
});

describe("collectUsage / listLogSessions — đọc từ .scoder/logs", () => {
  it("listLogSessions trả id mới nhất trước, bỏ file lạ", () => {
    writeLog("20260101-010101-aaaa", [{ type: "llm_usage", model: "gpt-4o-mini", usage: { input_tokens: 1, output_tokens: 1 } }]);
    writeLog("20260102-010101-bbbb", [{ type: "llm_usage", model: "gpt-4o-mini", usage: { input_tokens: 1, output_tokens: 1 } }]);
    writeFileSync(join(TMP, ".scoder/logs", "notes.txt"), "not a log");
    const ids = listLogSessions(TMP);
    assert.deepEqual(ids, ["20260102-010101-bbbb", "20260101-010101-aaaa"]);
  });

  it("collectUsage toàn bộ session", () => {
    writeLog("20260101-010101-aaaa", [{ type: "llm_usage", model: "gpt-4o-mini", usage: { input_tokens: 100, output_tokens: 50 } }]);
    writeLog("20260102-010101-bbbb", [{ type: "llm_usage", model: "gpt-4o-mini", usage: { input_tokens: 10, output_tokens: 5 } }]);
    const costs = collectUsage(TMP);
    assert.equal(costs.length, 2);
    const totalCalls = costs.reduce((s, c) => s + c.aggregate.calls, 0);
    assert.equal(totalCalls, 2);
  });

  it("collectUsage --last n chỉ lấy n session mới nhất", () => {
    for (const id of ["20260101-010101-aaaa", "20260102-010101-bbbb", "20260103-010101-cccc"]) {
      writeLog(id, [{ type: "llm_usage", model: "gpt-4o-mini", usage: { input_tokens: id.length, output_tokens: 0 } }]);
    }
    const costs = collectUsage(TMP, { last: 2 });
    assert.deepEqual(costs.map((c) => c.sessionId), ["20260103-010101-cccc", "20260102-010101-bbbb"]);
  });

  it("collectUsage --session <id> chỉ lấy 1 session", () => {
    writeLog("20260101-010101-aaaa", [{ type: "llm_usage", model: "gpt-4o-mini", usage: { input_tokens: 7, output_tokens: 0 } }]);
    writeLog("20260102-010101-bbbb", [{ type: "llm_usage", model: "gpt-4o-mini", usage: { input_tokens: 99, output_tokens: 0 } }]);
    const costs = collectUsage(TMP, { sessionId: "20260101-010101-aaaa" });
    assert.equal(costs.length, 1);
    assert.equal(costs[0].aggregate.inputTokens, 7);
  });

  it("session không có log -> aggregate 0 (không crash)", () => {
    const costs = collectUsage(TMP, { sessionId: "no-such-session" });
    assert.equal(costs.length, 1);
    assert.equal(costs[0].aggregate.calls, 0);
    assert.equal(costs[0].aggregate.costUsd, 0);
  });

  it("log JSONL lỗi format giữa chừng -> bỏ qua dòng lỗi", () => {
    writeLog("20260101-010101-aaaa", [
      { type: "llm_usage", model: "gpt-4o-mini", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const p = logFilePath(TMP, "20260101-010101-aaaa");
    writeFileSync(p, "{broken json\n" + readFileSync(p, "utf8"), "utf8");
    const costs = collectUsage(TMP, { sessionId: "20260101-010101-aaaa" });
    assert.equal(costs[0].aggregate.calls, 1);
  });
});

describe("formatCostReport", () => {
  it("báo cáo có TOTAL + cost cho session có usage", () => {
    writeLog("20260101-010101-aaaa", [
      { type: "llm_usage", model: "gpt-4o-mini", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
    ]);
    const costs = collectUsage(TMP);
    const report = formatCostReport(costs);
    assert.ok(report.includes("COST REPORT"));
    assert.ok(report.includes("20260101-010101-aaaa"));
    assert.ok(report.includes("TOTAL (1 session(s))"));
    assert.ok(report.includes("$0.7500"), `phải chứa $0.7500:\n${report}`);
  });

  it("không có usage -> thông báo hướng dẫn --log-file", () => {
    const report = formatCostReport([]);
    assert.ok(report.includes("No LLM usage recorded"));
    assert.ok(report.includes("--log-file"));
  });
});

describe("session metrics (latency / success / guardrails)", () => {
  it("extractSessionMetrics: đếm steps, latency, tools, guardrails, success", async () => {
    // import ở đây để không ảnh hưởng phần import trên (file đã có import group riêng)
    const { extractSessionMetrics } = await import("../dist/cost.js");
    const events = [
      { type: "step", step: 1, durationMs: 4000, toolCalls: 2 },
      { type: "tool", step: 1, tool: "read_file", ok: true, elapsedMs: 5 },
      { type: "guardrail", rule: "history-trim", action: "trim", reason: "x" },
      { type: "step", step: 2, durationMs: 6000, toolCalls: 1 },
      { type: "tool", step: 2, tool: "edit_file", ok: true, elapsedMs: 8 },
      { type: "guardrail", rule: "build-stop", action: "finish", reason: "y" },
      { type: "guardrail", rule: "doom-loop", action: "inject", reason: "z" },
      { type: "finish", success: true, steps: 2 },
    ];
    const m = extractSessionMetrics(events);
    assert.equal(m.stepCount, 2);
    assert.equal(m.stepLatencyTotalMs, 10_000);
    assert.equal(m.stepLatencyMaxMs, 6000);
    assert.equal(m.toolCallCount, 2);
    assert.equal(m.guardrailCount, 3);
    assert.equal(m.success, true);
  });

  it("extractSessionMetrics: session trống / chưa finish -> success null", async () => {
    const { extractSessionMetrics } = await import("../dist/cost.js");
    const m = extractSessionMetrics([{ type: "step", step: 1, durationMs: 100 }]);
    assert.equal(m.stepCount, 1);
    assert.equal(m.success, null);
  });

  it("formatCostReport: hiển thị steps, llm-avg, success-rate", async () => {
    const { extractSessionMetrics } = await import("../dist/cost.js");
    writeLog("20260101-010101-mmm", [
      { type: "llm_usage", model: "gpt-4o-mini", usage: { input_tokens: 100, output_tokens: 50 } },
      { type: "step", step: 1, durationMs: 2000, toolCalls: 1 },
      { type: "step", step: 2, durationMs: 4000, toolCalls: 0 },
      { type: "tool", step: 1, tool: "read_file", ok: true, elapsedMs: 3 },
      { type: "guardrail", rule: "history-trim", action: "trim", reason: "x" },
      { type: "finish", success: true, steps: 2 },
    ]);
    const costs = collectUsage(TMP, { sessionId: "20260101-010101-mmm" });
    assert.equal(costs[0].metrics.stepCount, 2);
    const report = formatCostReport(costs);
    assert.ok(report.includes("steps=2"), `phải có steps=2:\n${report}`);
    assert.ok(report.includes("llm-avg=3.0s"), `phải có llm-avg=3.0s:\n${report}`);
    assert.ok(report.includes("guardrails=1"));
    assert.ok(report.includes("✓success"));
    assert.ok(report.includes("success-rate=1/1"), `phải có success-rate:\n${report}`);
  });
});
