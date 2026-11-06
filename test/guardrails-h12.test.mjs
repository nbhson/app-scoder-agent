/**
 * Unit tests cho H-12 guardrail rules: error-loop + token-no-progress.
 * Chạy: node --test test/guardrails-h12.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorLoopRule, tokenNoProgressRule, createGuardrailEngine } from "../dist/agent/guardrails.js";

const baseCtx = {
  step: 5,
  maxSteps: 40,
  text: "",
  message: null,
  hasToolCalls: true,
  buildPassedThisStep: false,
  buildCallPresent: false,
  filesModified: true,
  chatDone: false,
};

describe("errorLoopRule (H-12)", () => {
  const rule = errorLoopRule({});
  it("inject 'change approach' khi cùng tool+error 3 lần", () => {
    const d = rule.evaluate({ ...baseCtx, toolErrorRepeat: 2 });
    assert.ok(d);
    assert.equal(d.action.kind, "inject");
    assert.match(d.action.reminder, /change your approach|different method/i);
  });
  it("engine mặc định chứa error-loop rule", () => {
    const eng = createGuardrailEngine();
    assert.ok(eng.listRules().some((r) => r.name === "error-loop"));
  });
});

describe("tokenNoProgressRule (H-12)", () => {
  const rule = tokenNoProgressRule({});
  it("finish sau 3 step liên tiếp outputTokens < 20", () => {
    const d = rule.evaluate({ ...baseCtx, outputTokensThisStep: 5, lowTokenStreak: 3 });
    assert.ok(d);
    assert.equal(d.action.kind, "finish");
    assert.equal(d.action.success, false);
  });
  it("không finish dưới 3 step", () => {
    assert.equal(rule.evaluate({ ...baseCtx, outputTokensThisStep: 5, lowTokenStreak: 2 }), null);
  });
  it("outputTokens >= 20 không kích hoạt", () => {
    assert.equal(rule.evaluate({ ...baseCtx, outputTokensThisStep: 50, lowTokenStreak: 5 }), null);
  });
  it("usage undefined (provider không báo) không kích hoạt", () => {
    assert.equal(rule.evaluate({ ...baseCtx, outputTokensThisStep: undefined, lowTokenStreak: 10 }), null);
  });

  it("engine-level (G1): tracker tự tính từ ctx — 3 bước low-token liên tiếp ⇒ finish", async () => {
    const eng = createGuardrailEngine();
    const feed = async () => await eng.evaluate({ ...baseCtx, outputTokensThisStep: 5 });
    await feed();
    await feed();
    const hit = await feed();
    const d = hit.find((x) => x.rule === "token-no-progress");
    assert.ok(d, "step thứ 3 phải kích hoạt");
    assert.equal(d.action.kind, "finish");
  });

  it("engine-level (G1): error-loop tự tính từ toolResults", async () => {
    const eng = createGuardrailEngine();
    const calls = { role: "assistant", content: null, tool_calls: [{ id: "t1", name: "run_command", arguments: "{}" }] };
    const results = new Map([["t1", { ok: false, output: "ERROR: module not found" }]]);
    const feed = async () => await eng.evaluate({ ...baseCtx, message: calls, toolResults: results });
    await feed();
    await feed();
    const hit = await feed();
    assert.ok(hit.find((x) => x.rule === "error-loop"), "lần error thứ 3 phải inject");
  });
});
