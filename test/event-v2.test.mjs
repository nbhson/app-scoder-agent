/**
 * Phase 0 — event schema v2 (additive): reducer folds new events without
 * breaking old consumers; run_start carries schemaVersion/agent; finish
 * carries usage/verification; queue/context/compaction/agent_start|end.
 */
import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { initialState, applyEvent } from "../dist/tui/state.js";
import { EVENT_SCHEMA_VERSION } from "../dist/agent.js";

describe("event schema v2", () => {
  it("EVENT_SCHEMA_VERSION is 3", () => {
    assert.equal(EVENT_SCHEMA_VERSION, 3);
  });

  it("run_start resets v2 state and records agent/schemaVersion", () => {
    const s = applyEvent(initialState(), {
      type: "run_start", task: "t", model: "m", provider: "p", workdir: "/w",
      buildCmd: "b", permission: "auto", schemaVersion: 2, agent: "plan",
    });
    assert.equal(s.agent, "plan");
    assert.deepEqual(s.queue, { pending: 0, steering: 0 });
    assert.equal(s.context, null);
    assert.equal(s.verification, null);
    assert.deepEqual(s.subagents, []);
  });

  it("run_start without v2 fields still folds (backward compat)", () => {
    const s = applyEvent(initialState(), {
      type: "run_start", task: "t", model: "m", provider: "p", workdir: "/w",
      buildCmd: "b", permission: "auto",
    });
    assert.equal(s.agent, "build");
    assert.equal(s.status, "running");
  });

  it("steer_queued / steer_delivered / queue track pending depth", () => {
    let s = initialState();
    s = applyEvent(s, { type: "steer_queued", mode: "steer", text: "a" });
    s = applyEvent(s, { type: "steer_queued", mode: "queue", text: "b" });
    assert.equal(s.queue.pending, 2);
    assert.equal(s.queue.steering, 1);
    // Absolute queue event (from agent) overwrites with the authoritative depth.
    s = applyEvent(s, { type: "queue", pending: 2, steering: 1 });
    assert.deepEqual(s.queue, { pending: 2, steering: 1 });
    s = applyEvent(s, { type: "steer_delivered", count: 2 });
    assert.deepEqual(s.queue, { pending: 0, steering: 0 });
  });

  it("compaction appends a divider item", () => {
    const s = applyEvent(initialState(), { type: "compaction", tokensBefore: 12_000, tokensAfter: 3_000, manual: true });
    const item = s.items.find((i) => i.kind === "compaction");
    assert.ok(item, "compaction item appended");
    assert.equal(item.tokensBefore, 12_000);
    assert.equal(item.tokensAfter, 3_000);
    assert.equal(item.manual, true);
  });

  it("context records tokens/window/pct", () => {
    const s = applyEvent(initialState(), { type: "context", tokens: 50_000, window: 100_000, pct: 50 });
    assert.deepEqual(s.context, { tokens: 50_000, window: 100_000, pct: 50 });
  });

  it("agent_start/agent_end maintain the subagent tree list", () => {
    let s = initialState();
    s = applyEvent(s, { type: "agent_start", id: "a1", parentId: "p", name: "explore", description: "find auth", model: "m" });
    assert.equal(s.subagents.length, 1);
    assert.equal(s.subagents[0].status, "running");
    s = applyEvent(s, { type: "agent_end", id: "a1", ok: true, steps: 4, summary: "done" });
    assert.equal(s.subagents[0].status, "ok");
    assert.equal(s.subagents[0].steps, 4);
  });

  it("finish merges usage + verification into state", () => {
    const s = applyEvent(initialState(), {
      type: "finish", success: true, steps: 3, summary: "ok",
      usage: { calls: 2, inputTokens: 100, outputTokens: 50, cachedTokens: 10 },
      verification: { ok: true, detail: "build passed: npm run build" },
    });
    assert.equal(s.usage.calls, 2);
    assert.equal(s.usage.cachedTokens, 10);
    assert.equal(s.verification?.ok, true);
    assert.equal(s.status, "success");
  });

  it("tool_progress appends message to the running tool card", () => {
    let s = initialState();
    s = applyEvent(s, { type: "tool_call", step: 1, id: "t1", name: "run_command", args: {} });
    s = applyEvent(s, { type: "tool_progress", id: "t1", name: "run_command", current: 3, total: 10, message: "downloading" });
    assert.match(s.items.find((i) => i.kind === "tool").output, /downloading/);
  });
});

describe("event schema v3 — route_decision (P2.2, additive)", () => {
  it("reducer hiện tại fold an toàn (Phase C mới tô UI — không crash, không đổi state)", () => {
    let s = initialState();
    s = applyEvent(s, { type: "run_start", task: "t", model: "m", provider: "p", workdir: "/w", buildCmd: "b", permission: "auto", schemaVersion: 3, routingMode: "auto" });
    const before = JSON.stringify(s.items);
    s = applyEvent(s, {
      type: "route_decision", step: 2, tier: "small", model: "qwen", provider: "box-api",
      ref: "box-api/qwen", reason: "score -2: flat history", signals: { score: -2 }, switched: false,
    });
    assert.equal(s.status, "running"); // run_start vẫn bình thường
    assert.equal(JSON.stringify(s.items), before); // transcript chưa đổi (Phase C/D)
  });

  it("route_decision serialize/deserialize round-trip qua JSONL + extract", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { readJsonlLog, extractRouteEvents } = await import("../dist/session/cost.js");
    const dir = join("/tmp", `ev3-route-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const ev = {
      type: "route_decision", step: 5, tier: "large", model: "k3", provider: "box-api",
      ref: "box-api/k3", reason: "judge: sửa 1 dòng", signals: { score: 2, judgeRef: "box-api/k3" },
      switched: true, judge: { model: "box-api/k3", confidence: 0.8, ms: 220, tokens: 340, verdict: "accept" },
    };
    try {
      const p = join(dir, "s.jsonl");
      writeFileSync(p, JSON.stringify(ev) + "\n", "utf8");
      const [back] = readJsonlLog(p);
      assert.deepEqual(back, ev);
      const [r] = extractRouteEvents("s", [back]);
      assert.equal(r.tier, "large");
      assert.equal(r.judgeVerdict, "accept");
      assert.deepEqual(r.signals, undefined); // signals sống trong JSONL, không vào RouteEvent
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
