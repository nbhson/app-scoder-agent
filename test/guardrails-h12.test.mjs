/**
 * Unit tests cho H-12 guardrail rules: error-loop + token-no-progress.
 * Chạy: node --test test/guardrails-h12.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorLoopRule, tokenNoProgressRule, createGuardrailEngine } from "../dist/guardrails.js";

const baseCtx = {
  step: 5,
  maxSteps: 40,
  text: "",
  message: null,
  hasToolCalls: true,
  buildPassedThisStep: false,
  buildCallPresent: false,
  filesModified: true,
  textOnlyStreak: 0,
  sigRepeat: 0,
  wrapUpInjected: false,
  chatDone: false,
  toolErrorSig: "run_command:ERROR: module not found",
  toolErrorRepeat: 0,
  textOnlyLowTokenStreak: 0,
};

describe("errorLoopRule (H-12)", () => {
  const rule = errorLoopRule({});
  it("inject 'change approach' khi cùng tool+error 3 lần", () => {
    const d = rule.evaluate({ ...baseCtx, toolErrorRepeat: 2 });
    assert.ok(d);
    assert.equal(d.action.kind, "inject");
    assert.match(d.action.reminder, /change your approach|different method/i);
  });
  it("không kích hoạt dưới ngưỡng", () => {
    assert.equal(rule.evaluate({ ...baseCtx, toolErrorRepeat: 0 }), null);
    assert.equal(rule.evaluate({ ...baseCtx, toolErrorRepeat: 1 }), null);
  });
  it("engine mặc định chứa error-loop rule", () => {
    const eng = createGuardrailEngine();
    assert.ok(eng.listRules().some((r) => r.name === "error-loop"));
  });
});

describe("tokenNoProgressRule (H-12)", () => {
  const rule = tokenNoProgressRule({});
  it("finish sau 3 step liên tiếp outputTokens < 20", () => {
    const d = rule.evaluate({ ...baseCtx, outputTokensThisStep: 5, textOnlyLowTokenStreak: 3 });
    assert.ok(d);
    assert.equal(d.action.kind, "finish");
    assert.equal(d.action.success, false);
  });
  it("không finish dưới 3 step", () => {
    assert.equal(rule.evaluate({ ...baseCtx, outputTokensThisStep: 5, textOnlyLowTokenStreak: 2 }), null);
  });
  it("outputTokens >= 20 không kích hoạt", () => {
    assert.equal(rule.evaluate({ ...baseCtx, outputTokensThisStep: 50, textOnlyLowTokenStreak: 5 }), null);
  });
  it("usage undefined (provider không báo) không kích hoạt", () => {
    assert.equal(rule.evaluate({ ...baseCtx, outputTokensThisStep: undefined, textOnlyLowTokenStreak: 10 }), null);
  });
});
