/**
 * P2.2 Phase A (plan/P2-02 §2, §5) — L1 classifier + L2 rule engine thuần.
 * Chạy: npm run build && node --test test/router-classify.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify, applyRules, matchRule, phaseFromToolCall, GRAY_BAND } from "../dist/router/classifier.js";
import { estimateHistoryTokens, IDLE_TURN_CONTEXT } from "../dist/router/types.js";

const CFG = {
  signals: { smallMaxCtxTokens: 16000, largeToolSchemaChars: 30000 },
  rules: [],
  escalate: { buildFails: 2, stickyMinSteps: 2 },
};
const sig = (over = {}) => ({
  estTokens: 1000,
  toolSchemaChars: 1000,
  toolCount: 5,
  endsInToolResults: false,
  ...over,
});
const ctx = (over = {}) => ({ ...IDLE_TURN_CONTEXT, ...over });

describe("classify — từng signal một (bảng §2)", () => {
  it("history nhỏ + phase explore → small (score âm)", () => {
    const r = classify(sig(), ctx({ phase: "explore", step: 5, maxSteps: 40 }), CFG);
    assert.equal(r.tier, "small");
    assert.ok(r.score < 0);
  });

  it("estTokens ≥ smallMaxCtxTokens → +1 và ghi reason ctx", () => {
    const r = classify(sig({ estTokens: 16000 }), ctx(), CFG);
    assert.match(r.reason, /ctx 16k/);
    assert.equal(r.gray, true); // score 1 → vùng gray
  });

  it("phase edit/build/verify/self-review → large (+2)", () => {
    for (const phase of ["edit", "build", "verify", "self-review"]) {
      const r = classify(sig(), ctx({ phase }), CFG);
      assert.equal(r.tier, "large", phase);
      assert.ok(!r.gray, phase);
    }
  });

  it("tool schema vượt ngưỡng → +1 tools N", () => {
    const r = classify(sig({ toolSchemaChars: 30001, toolCount: 24 }), ctx(), CFG);
    assert.match(r.reason, /tools 24/);
  });

  it("step 1 (plan) và 2 step cuối (wrap-up) → large-leaning", () => {
    assert.match(classify(sig(), ctx({ step: 1, maxSteps: 40 }), CFG).reason, /plan step/);
    assert.match(classify(sig(), ctx({ step: 39, maxSteps: 40 }), CFG).reason, /wrap-up/);
  });

  it("lượt tổng hợp (toàn tool results, không tool call mới) → +1 synthesis", () => {
    const r = classify(sig({ endsInToolResults: true }), ctx({ step: 5 }), CFG);
    assert.match(r.reason, /synthesis/);
  });

  it("tổ hợp nặng: phase edit + ctx lớn + wrap-up → large, not gray", () => {
    const r = classify(sig({ estTokens: 40000 }), ctx({ phase: "edit", step: 39, maxSteps: 40 }), CFG);
    assert.equal(r.tier, "large");
    assert.equal(r.gray, false);
    assert.ok(r.score >= 3);
  });

  it("không signal nào → flat history, small, gray (sàn của band)", () => {
    const r = classify(sig(), ctx({ step: 5, maxSteps: 40 }), CFG);
    assert.equal(r.reason, "flat history");
    assert.equal(r.tier, "small");
  });

  it("GRAY_BAND = 1 — |score| ≤ 1 là gray", () => {
    assert.equal(GRAY_BAND, 1);
    assert.equal(classify(sig({ toolSchemaChars: 30001 }), ctx(), CFG).gray, true); // +1
  });

  it("signals map chứa đủ key cho audit panel", () => {
    const r = classify(sig(), ctx({ phase: "edit" }), CFG);
    for (const k of ["score", "estTokens", "toolSchemaChars", "toolCount", "phase"]) assert.ok(k in r.signals, k);
  });
});

describe("applyRules / matchRule — DSL 'khi'", () => {
  it("phase == edit → ép small vẫn thắng heuristic", () => {
    const r = applyRules([{ when: "phase == edit", use: "small" }], ctx({ phase: "edit" }), sig());
    assert.deepEqual(r, { tier: "small", reason: "rule: phase == edit" });
  });

  it("step == 1 → use large (rule thắng score, reason ghi đúng when)", () => {
    const rules = [{ when: "step == 1", use: "large" }];
    assert.equal(applyRules(rules, ctx({ step: 1 }), sig())?.tier, "large");
    assert.equal(applyRules(rules, ctx({ step: 2 }), sig()), null);
  });

  it("tokens >= / tools != số, so sánh hoa-thường với phase", () => {
    assert.ok(matchRule({ when: "tokens >= 20000", use: "large" }, ctx(), sig({ estTokens: 25000 })));
    assert.ok(!matchRule({ when: "tokens >= 20000", use: "large" }, ctx(), sig({ estTokens: 100 })));
    assert.ok(matchRule({ when: "tools != 0", use: "large" }, ctx(), sig({ toolCount: 3 })));
    assert.ok(matchRule({ when: "phase == EDIT", use: "large" }, ctx({ phase: "edit" }), sig()));
    assert.ok(matchRule({ when: "phase != edit", use: "small" }, ctx({ phase: "explore" }), sig()));
  });

  it("rule đầu tiên khớp thắng; when sai cú pháp/số rác → không khớp", () => {
    const rules = [
      { when: "step == abc", use: "large" }, // NaN → không khớp
      { when: "phase == edit", use: "large" },
      { when: "phase == edit", use: "small" },
    ];
    assert.equal(applyRules(rules, ctx({ phase: "edit" }), sig())?.tier, "large");
    assert.equal(applyRules([{ when: "garbage", use: "large" }], ctx(), sig()), null);
    assert.equal(applyRules([{ when: "unknown == 1", use: "large" }], ctx(), sig()), null);
    assert.equal(applyRules([{ when: "step == 1", use: "medium" }], ctx({ step: 1 }), sig()), null); // use sai tier
  });

  it("step <= 3 hoạt động (số học đầy đủ 4 op)", () => {
    assert.ok(matchRule({ when: "step <= 3", use: "large" }, ctx({ step: 3 }), sig()));
    assert.ok(!matchRule({ when: "step <= 3", use: "large" }, ctx({ step: 4 }), sig()));
  });
});

describe("phaseFromToolCall + estimateHistoryTokens", () => {
  it("tool → phase: read=grep explore, edit_file edit, run_command build, finish verify", () => {
    assert.equal(phaseFromToolCall("grep"), "explore");
    assert.equal(phaseFromToolCall("read_file"), "explore");
    assert.equal(phaseFromToolCall("edit_file"), "edit");
    assert.equal(phaseFromToolCall("write_file"), "edit");
    assert.equal(phaseFromToolCall("run_command"), "build");
    assert.equal(phaseFromToolCall("finish"), "verify");
    assert.equal(phaseFromToolCall("mcp__x__y"), "tool");
    assert.equal(phaseFromToolCall(null), null);
  });

  it("ước lượng token = chars/4, tính cả tool_calls (name + arguments)", () => {
    const msgs = [
      { role: "user", content: "x".repeat(400) },
      { role: "assistant", content: null, tool_calls: [{ id: "1", name: "edit_file", arguments: "y".repeat(391) }] },
    ];
    assert.equal(estimateHistoryTokens(msgs), 200); // (400 + 9 + 391)/4
  });
});
