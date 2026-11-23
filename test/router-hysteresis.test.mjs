/**
 * P2.2 Phase A (plan/P2-02 §4) — L3 hysteresis thuần: build-lock, escalation
 * thắng sticky, demote cần 3 bước sạch, chống dao động.
 * Chạy: npm run build && node --test test/router-hysteresis.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hysteresisDecide, initialHysteresis } from "../dist/router/hysteresis.js";
import { IDLE_TURN_CONTEXT } from "../dist/router/types.js";

const CFG = { buildFails: 2, stickyMinSteps: 2 };
const ctx = (over = {}) => ({ ...IDLE_TURN_CONTEXT, ...over });

describe("escalate (small → large) — vô điều kiện", () => {
  it("build fail ≥ ngưỡng → large + reason escalate, kể cả khi L1 muốn small", () => {
    const { result, state } = hysteresisDecide("small", initialHysteresis("small"), ctx({ buildFailStreak: 2 }), CFG);
    assert.equal(result.tier, "large");
    assert.match(result.override, /escalate: build fail ×2/);
    assert.ok(result.flipped);
    assert.equal(state.tier, "large");
  });

  it("guardrail doom-loop ×2 và tool-args repair ×2 cũng escalate", () => {
    assert.match(hysteresisDecide("small", initialHysteresis("small"), ctx({ guardrailStreak: 2 }), CFG).result.override, /guardrail/);
    assert.match(hysteresisDecide("small", initialHysteresis("small"), ctx({ toolArgsRepairStreak: 2 }), CFG).result.override, /tool-args repair/);
  });

  it("escalation THẮNG sticky — an toàn quan trọng hơn ổn định", () => {
    const fresh = { tier: "small", stepsSinceSwitch: 0, cleanSteps: 0 }; // vừa flip xong
    const { result } = hysteresisDecide("small", fresh, ctx({ buildFailStreak: 3 }), CFG);
    assert.equal(result.tier, "large");
    assert.match(result.override, /^escalate/);
  });
});

describe("build đang fail → KHOÁ large tới khi pass", () => {
  it("streak 1 (dưới ngưỡng) trên large + L1 muốn small → hold: build failing", () => {
    const st = { tier: "large", stepsSinceSwitch: 10, cleanSteps: 10 };
    const { result } = hysteresisDecide("small", st, ctx({ buildFailStreak: 1, phase: "explore" }), CFG);
    assert.equal(result.tier, "large");
    assert.match(result.override, /hold large: build failing/);
  });
});

describe("demote (large → small) — cần bằng chứng", () => {
  it("3 bước sạch + phase nhẹ → được demote", () => {
    const st = { tier: "large", stepsSinceSwitch: 5, cleanSteps: 3 };
    const { result } = hysteresisDecide("small", st, ctx({ phase: "explore" }), CFG);
    assert.equal(result.tier, "small");
    assert.equal(result.override, "");
    assert.ok(result.flipped);
  });

  it("clean streak < 3 → hold", () => {
    const st = { tier: "large", stepsSinceSwitch: 5, cleanSteps: 2 };
    assert.match(hysteresisDecide("small", st, ctx({ phase: "explore" }), CFG).result.override, /clean streak < 3/);
  });

  it("phase còn nặng (edit/build/verify) → hold dù sạch 5 bước", () => {
    const st = { tier: "large", stepsSinceSwitch: 5, cleanSteps: 5 };
    for (const phase of ["edit", "build", "verify"]) {
      assert.match(hysteresisDecide("small", st, ctx({ phase }), CFG).result.override, /phase still heavy/);
    }
  });
});

describe("sticky — chống dao động", () => {
  it("flip non-escalate trong vòng stickyMinSteps → giữ tier cũ", () => {
    const justFlipped = { tier: "small", stepsSinceSwitch: 0, cleanSteps: 0 };
    const { result } = hysteresisDecide("large", justFlipped, ctx({ phase: "edit" }), CFG);
    assert.equal(result.tier, "small");
    assert.match(result.override, /sticky: hold small \(0\/2\)/);
  });

  it("đủ số bước → flip được phép", () => {
    const aged = { tier: "small", stepsSinceSwitch: 2, cleanSteps: 0 };
    const { result } = hysteresisDecide("large", aged, ctx({ phase: "edit" }), CFG);
    assert.equal(result.tier, "large");
    assert.ok(result.flipped);
  });

  it("demote bị sticky chặn dù clean đủ — cả hai điều kiện phải thoả", () => {
    const st = { tier: "large", stepsSinceSwitch: 1, cleanSteps: 4 };
    const { result } = hysteresisDecide("small", st, ctx({ phase: "explore" }), CFG);
    assert.equal(result.tier, "large");
    assert.match(result.override, /sticky/);
  });
});

describe("bộ đếm tự chạy đúng", () => {
  it("quyết định đầu (tier null) → không override, stepsSinceSwitch 0", () => {
    const { result, state } = hysteresisDecide("small", initialHysteresis(null), ctx(), CFG);
    assert.equal(result.tier, "small");
    assert.equal(result.override, "");
    assert.equal(state.stepsSinceSwitch, 0);
  });

  it("large + bước sạch → cleanSteps tăng; có lỗi → reset 0; small không đếm", () => {
    const st = { tier: "large", stepsSinceSwitch: 5, cleanSteps: 2 };
    assert.equal(hysteresisDecide("large", st, ctx(), CFG).state.cleanSteps, 3);
    assert.equal(hysteresisDecide("large", st, ctx({ buildFailStreak: 1 }), CFG).state.cleanSteps, 0);
    const onSmall = { tier: "small", stepsSinceSwitch: 5, cleanSteps: 4 };
    assert.equal(hysteresisDecide("small", onSmall, ctx(), CFG).state.cleanSteps, 4);
  });

  it("flip → stepsSinceSwitch reset 0; không flip → +1", () => {
    const aged = { tier: "small", stepsSinceSwitch: 3, cleanSteps: 0 };
    assert.equal(hysteresisDecide("large", aged, ctx({ phase: "edit" }), CFG).state.stepsSinceSwitch, 0);
    assert.equal(hysteresisDecide("small", aged, ctx(), CFG).state.stepsSinceSwitch, 4);
  });
});
