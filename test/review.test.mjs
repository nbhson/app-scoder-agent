/**
 * T2: review state machine (/review prompt-gate) — module thuần.
 * Chạy: node --test test/review.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewFromResponse, reviewAnswerToCall } from "../dist/tui/review.js";

describe("reviewFromResponse (T2)", () => {
  const tool = "mcp__prompt-gate__review_and_select_prompt";

  it("không ok → error notice, state null", () => {
    const r = reviewFromResponse(null, tool, {}, { ok: false, output: "boom" });
    assert.equal(r.ok, false);
    assert.equal(r.state, null);
    assert.match(r.notice.text, /prompt gate error/);
  });

  it("pending_level_selection → stage level + hướng dẫn 1-3", () => {
    const r = reviewFromResponse(null, tool, { prompt: "x" }, { ok: true, output: "", structured: { status: "pending_level_selection" } });
    assert.equal(r.state.stage, "level");
    assert.match(r.notice.text, /\[1\] light/);
  });

  it("pending_user_selection → stage selection + rewrittenPrompt verbatim", () => {
    const r = reviewFromResponse(null, tool, { prompt: "x" }, { ok: true, output: "", structured: { status: "pending_user_selection", original_prompt: "orig", rewritten_prompt: "rew" } });
    assert.equal(r.state.stage, "selection");
    assert.equal(r.state.rewrittenPrompt, "rew");
    assert.match(r.notice.text, /--- ORIGINAL ---/);
    assert.match(r.notice.text, /orig/);
  });

  it("approved → state null + selected_prompt", () => {
    const r = reviewFromResponse(null, tool, {}, { ok: true, output: "", structured: { status: "approved", selected_prompt: "final" } });
    assert.equal(r.state, null);
    assert.match(r.notice.text, /final/);
  });

  it("status lạ → warn", () => {
    const r = reviewFromResponse(null, tool, {}, { ok: true, output: "", structured: { status: "weird" } });
    assert.equal(r.notice.level, "warn");
  });
});

describe("reviewAnswerToCall (T2)", () => {
  const level = { stage: "level", tool: "t", argsBase: { prompt: "x", language: "vietnamese" } };

  it("stage level: reply 2 → rewrite_level balanced", () => {
    const r = reviewAnswerToCall(level, "2");
    assert.deepEqual(r.nextCall.args.rewrite_level, "balanced");
  });

  it("stage level: reply sai → warn, không call", () => {
    const r = reviewAnswerToCall(level, "abc");
    assert.equal(r.nextCall, null);
    assert.equal(r.notice.level, "warn");
  });

  const sel = { stage: "selection", tool: "t", argsBase: { prompt: "x" }, rewrittenPrompt: "rew" };

  it("stage selection: 1 → original, không echo rewritten_prompt", () => {
    const r = reviewAnswerToCall(sel, "1");
    assert.equal(r.nextCall.args.selection, "original");
    assert.equal(r.nextCall.args.rewritten_prompt, undefined);
  });

  it("stage selection: 2 → rewritten + rewritten_prompt echo", () => {
    const r = reviewAnswerToCall(sel, "2");
    assert.equal(r.nextCall.args.selection, "rewritten");
    assert.equal(r.nextCall.args.rewritten_prompt, "rew");
  });

  it("stage selection: 3 + feedback → update", () => {
    const r = reviewAnswerToCall(sel, "3 make it shorter");
    assert.equal(r.nextCall.args.selection, "update");
    assert.equal(r.nextCall.args.feedback, "make it shorter");
  });

  it("stage selection: 3 không feedback → warn", () => {
    const r = reviewAnswerToCall(sel, "3");
    assert.equal(r.nextCall, null);
    assert.match(r.notice.text, /needs your requested changes/);
  });

  it("stage selection: 4 → cancel", () => {
    const r = reviewAnswerToCall(sel, "4");
    assert.equal(r.nextCall.args.selection, "cancel");
  });
});
