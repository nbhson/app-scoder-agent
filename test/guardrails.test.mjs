/**
 * Unit tests cho guardrails.js — Guardrail Engine: rule mặc định, ngưỡng
 * cấu hình, thứ tự ưu tiên và decision logging.
 *
 * Rule được test thuần function (không cần LLM/build thật).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GuardrailEngine,
  createGuardrailEngine,
  defaultGuardrailRules,
  DEFAULT_GUARDRAIL_OPTIONS,
  CHAT_DONE_MARKER,
} from "../dist/guardrails.js";

/** Context gốc tiện dụng — test override từng trường. */
const baseCtx = (over = {}) => ({
  step: 1,
  maxSteps: 40,
  text: "",
  message: null,
  hasToolCalls: false,
  buildPassedThisStep: false,
  buildCallPresent: false,
  filesModified: false,
  textOnlyStreak: 0,
  sigRepeat: 0,
  wrapUpInjected: false,
  chatDone: false,
  ...over,
});

describe("guardrails — Guardrail Engine", () => {
  it("có ít nhất 5 rule mặc định, mỗi rule có name + description", () => {
    const rules = defaultGuardrailRules();
    assert.ok(rules.length >= 5, `cần >=5 rule, thấy ${rules.length}`);
    for (const r of rules) {
      assert.equal(typeof r.name, "string");
      assert.ok(r.name.length > 0);
      assert.equal(typeof r.description, "string");
      assert.equal(typeof r.evaluate, "function");
    }
  });

  it("chat-done: marker → finish success chatOnly, marker bị làm sạch khỏi summary", () => {
    const eng = new GuardrailEngine();
    const ds = eng.evaluate(
      baseCtx({ text: `Xong rồi nhé ${CHAT_DONE_MARKER}`, chatDone: true }),
    );
    const d = ds.find((x) => x.rule === "chat-done");
    assert.ok(d, "phải kích hoạt chat-done");
    assert.equal(d.action.kind, "finish");
    assert.equal(d.action.success, true);
    assert.equal(d.action.chatOnly, true);
    assert.equal(d.action.summary, "Xong rồi nhé");
    assert.ok(!d.action.summary.includes(CHAT_DONE_MARKER), "summary không chứa marker");
  });

  it("completion-claim: claim hoàn thành + đã sửa file → verify-build (không tin lời nói)", () => {
    const eng = new GuardrailEngine();
    const ds = eng.evaluate(
      baseCtx({ text: "The task is now complete", filesModified: true }),
    );
    const d = ds.find((x) => x.rule === "completion-claim");
    assert.ok(d);
    assert.equal(d.action.kind, "verify-build");
    assert.ok(d.action.failReminder.length > 0);
  });

  it("completion-claim: claim hoàn thành + KHÔNG sửa file → finish luôn (bỏ qua build)", () => {
    const eng = new GuardrailEngine();
    const ds = eng.evaluate(
      baseCtx({ text: "All done — the answer is 42", filesModified: false }),
    );
    const d = ds.find((x) => x.rule === "completion-claim");
    assert.ok(d);
    assert.equal(d.action.kind, "finish");
    assert.equal(d.action.success, true);
  });

  it("text-only-streak: đủ N bước chỉ nói + không sửa file → dừng run (thuật toán 'chào')", () => {
    const eng = new GuardrailEngine();
    const below = eng.evaluate(baseCtx({ text: "hmm", textOnlyStreak: 1 }));
    assert.ok(!below.find((x) => x.rule === "text-only-streak"), "chưa đạt ngưỡng thì chưa kích hoạt");
    const hit = eng.evaluate(baseCtx({ text: "hmm", textOnlyStreak: 2 }));
    const d = hit.find((x) => x.rule === "text-only-streak");
    assert.ok(d, "đạt ngưỡng phải kích hoạt");
    assert.equal(d.action.kind, "finish");
    // Nếu đã sửa file thì không dừng (model đang làm việc thật)
    const withFiles = eng.evaluate(baseCtx({ text: "hmm", textOnlyStreak: 5, filesModified: true }));
    assert.ok(!withFiles.find((x) => x.rule === "text-only-streak"));
  });

  it("continue-nudge: text thường không claim → inject lời nhắc tiếp tục", () => {
    const eng = new GuardrailEngine();
    const ds = eng.evaluate(baseCtx({ text: "Đang phân tích code..." }));
    const d = ds.find((x) => x.rule === "continue-nudge");
    assert.ok(d);
    assert.equal(d.action.kind, "inject");
    assert.ok(d.action.reminder.includes("Continue working"));
  });

  it("doom-loop: chuỗi tool call giống hệt lặp lại quá ngưỡng → inject can thiệp", () => {
    const eng = new GuardrailEngine();
    const ctx = baseCtx({ hasToolCalls: true, sigRepeat: DEFAULT_GUARDRAIL_OPTIONS.doomLoopRepeats });
    const ds = eng.evaluate(ctx);
    const d = ds.find((x) => x.rule === "doom-loop");
    assert.ok(d);
    assert.equal(d.action.kind, "inject");
    assert.ok(d.action.reminder.includes("loop"));
    // Dưới ngưỡng thì không kích hoạt
    const quiet = eng.evaluate(baseCtx({ hasToolCalls: true, sigRepeat: 1 }));
    assert.ok(!quiet.find((x) => x.rule === "doom-loop"));
  });

  it("build-stop: tool chạy đúng build command thành công → finish; thất bại → verify-build", () => {
    const eng = new GuardrailEngine();
    const ok = eng.evaluate(
      baseCtx({ hasToolCalls: true, buildCallPresent: true, buildPassedThisStep: true, text: "Fixed it" }),
    );
    const dOk = ok.find((x) => x.rule === "build-stop");
    assert.ok(dOk);
    assert.equal(dOk.action.kind, "finish");
    assert.equal(dOk.action.summary, "Fixed it");

    const fail = eng.evaluate(
      baseCtx({ hasToolCalls: true, buildCallPresent: true, buildPassedThisStep: false }),
    );
    const dFail = fail.find((x) => x.rule === "build-stop");
    assert.ok(dFail);
    assert.equal(dFail.action.kind, "verify-build");
  });

  it("wrap-up: cách N bước hết budget → inject reminder đúng một lần", () => {
    const eng = new GuardrailEngine();
    const n = DEFAULT_GUARDRAIL_OPTIONS.wrapUpStepsBeforeEnd;
    const ds = eng.evaluate(baseCtx({ step: 38, maxSteps: 40 }));
    const d = ds.find((x) => x.rule === "wrap-up");
    assert.ok(d, "phải inject khi còn 2 bước");
    assert.equal(d.action.kind, "inject");
    // Đã inject rồi thì không lặp lại
    const again = eng.evaluate(baseCtx({ step: 38, maxSteps: 40, wrapUpInjected: true }));
    assert.ok(!again.find((x) => x.rule === "wrap-up"));
    // Còn nhiều bước thì chưa
    const early = eng.evaluate(baseCtx({ step: 10, maxSteps: 40 }));
    assert.ok(!early.find((x) => x.rule === "wrap-up"));
    assert.equal(n, 2);
  });

  it("history-trim: luôn yêu cầu trim context sau mỗi bước", () => {
    const eng = new GuardrailEngine();
    const ds = eng.evaluate(baseCtx());
    const d = ds.find((x) => x.rule === "history-trim");
    assert.ok(d);
    assert.equal(d.action.kind, "trim");
  });

  it("ngưỡng cấu hình được qua GuardrailOptions (không sửa runLoop)", () => {
    const eng = createGuardrailEngine({ textOnlyStreakLimit: 5 });
    const at2 = eng.evaluate(baseCtx({ text: "hi", textOnlyStreak: 2 }));
    assert.ok(!at2.find((x) => x.rule === "text-only-streak"), "ngưỡng 5 thì streak 2 chưa dừng");
    const at5 = eng.evaluate(baseCtx({ text: "hi", textOnlyStreak: 5 }));
    assert.ok(at5.find((x) => x.rule === "text-only-streak"), "streak 5 phải dừng");
  });

  it("thứ tự ưu tiên: chat-done đứng trước continue-nudge (không nudge lượt chat)", () => {
    const eng = new GuardrailEngine();
    const ds = eng.evaluate(baseCtx({ text: "hi there", chatDone: true }));
    const names = ds.map((x) => x.rule);
    assert.ok(names.includes("chat-done"));
    assert.ok(!names.includes("continue-nudge"), "lượt chat không được nudge");
    assert.ok(names.indexOf("chat-done") < names.indexOf("history-trim"));
  });

  it("onDecision callback: mỗi rule kích hoạt đều được log", () => {
    const logged = [];
    const eng = new GuardrailEngine(undefined, (d) => logged.push(d));
    eng.evaluate(baseCtx({ text: "The task is now complete", filesModified: true }));
    assert.ok(logged.some((d) => d.rule === "completion-claim"));
    assert.ok(logged.every((d) => d.rule && d.reason && d.action.kind));
  });

  it("rule lỗi (throw) không làm gãy engine — trả decision none", () => {
    const eng = new GuardrailEngine([
      {
        name: "broken",
        description: "always throws",
        evaluate() {
          throw new Error("boom");
        },
      },
    ]);
    const ds = eng.evaluate(baseCtx());
    const d = ds.find((x) => x.rule === "broken");
    assert.ok(d);
    assert.equal(d.action.kind, "none");
  });

  it("register: thêm rule tùy chỉnh chạy cùng rule mặc định", () => {
    const eng = createGuardrailEngine();
    eng.register({
      name: "custom-never-say-never",
      description: "test rule",
      evaluate(ctx) {
        return ctx.text.includes("forbidden") ? { action: { kind: "finish", success: false, summary: "blocked" }, reason: "test" } : null;
      },
    });
    const hit = eng.evaluate(baseCtx({ text: "this is forbidden" }));
    assert.ok(hit.find((x) => x.rule === "custom-never-say-never"));
    const quiet = eng.evaluate(baseCtx({ text: "all good" }));
    assert.ok(!quiet.find((x) => x.rule === "custom-never-say-never"));
  });
});
