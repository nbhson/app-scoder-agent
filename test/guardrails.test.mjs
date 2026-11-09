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
} from "../dist/agent/guardrails.js";

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

  it("chat-done: marker → finish success chatOnly, marker bị làm sạch khỏi summary", async () => {
    const eng = new GuardrailEngine();
    const ds = await eng.evaluate(
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

  it("completion-claim: claim hoàn thành + đã sửa file → verify-build (không tin lời nói)", async () => {
    const eng = new GuardrailEngine();
    const ds = await eng.evaluate(
      baseCtx({ text: "The task is now complete", filesModified: true }),
    );
    const d = ds.find((x) => x.rule === "completion-claim");
    assert.ok(d);
    assert.equal(d.action.kind, "verify-build");
    assert.ok(d.action.failReminder.length > 0);
  });

  it("completion-claim: claim hoàn thành + KHÔNG sửa file → finish luôn (bỏ qua build)", async () => {
    const eng = new GuardrailEngine();
    const ds = await eng.evaluate(
      baseCtx({ text: "All done — the answer is 42", filesModified: false }),
    );
    const d = ds.find((x) => x.rule === "completion-claim");
    assert.ok(d);
    assert.equal(d.action.kind, "finish");
    assert.equal(d.action.success, true);
  });

  it("text-only-streak: đủ N bước chỉ nói + không sửa file → dừng run (thuật toán 'chào')", async () => {
    const eng = new GuardrailEngine();
    // G1: tracker trong engine — mô phỏng 1 bước text-only rồi kiểm tra ngưỡng.
    const step1 = await eng.evaluate(baseCtx({ text: "hmm", step: 1 }));
    assert.ok(!step1.find((x) => x.rule === "text-only-streak"), "chưa đạt ngưỡng thì chưa kích hoạt");
    await eng.evaluate(baseCtx({ text: "hmm", step: 2 }));
    const hit = await eng.evaluate(baseCtx({ text: "hmm", step: 3 }));
    const d = hit.find((x) => x.rule === "text-only-streak");
    assert.ok(d, "đạt ngưỡng phải kích hoạt");
    assert.equal(d.action.kind, "finish");
    // Có tool call giữa chừng → streak reset, không dừng dù đã sửa file
    const eng2 = new GuardrailEngine();
    await eng2.evaluate(baseCtx({ text: "hmm", step: 1 }));
    await eng2.evaluate(baseCtx({ text: "hmm", step: 2, hasToolCalls: true, message: { role: "assistant", content: null, tool_calls: [{ id: "1", name: "read_file", arguments: "{}" }] } }));
    const withFiles = await eng2.evaluate(baseCtx({ text: "hmm", step: 3, filesModified: true }));
    assert.ok(!withFiles.find((x) => x.rule === "text-only-streak"));
  });

  it("continue-nudge: text thường không claim → inject lời nhắc tiếp tục", async () => {
    const eng = new GuardrailEngine();
    const ds = await eng.evaluate(baseCtx({ text: "Đang phân tích code..." }));
    const d = ds.find((x) => x.rule === "continue-nudge");
    assert.ok(d);
    assert.equal(d.action.kind, "inject");
    assert.ok(d.action.reminder.includes("Continue working"));
  });

  it("continue-nudge: chưa sửa file → không ép build, chỉ đường thoát <<CHAT_DONE>>", async () => {
    const eng = new GuardrailEngine();
    const ds = await eng.evaluate(baseCtx({ text: "Đây là câu trả lời cho câu hỏi.", filesModified: false }));
    const d = ds.find((x) => x.rule === "continue-nudge");
    assert.ok(d);
    assert.equal(d.action.kind, "inject");
    assert.ok(d.action.reminder.includes(CHAT_DONE_MARKER));
    assert.ok(!d.action.reminder.includes("Build must pass before you finish"));
  });

  it("doom-loop: chuỗi tool call giống hệt lặp lại quá ngưỡng → inject can thiệp", async () => {
    const eng = new GuardrailEngine();
    const calls = { role: "assistant", content: null, tool_calls: [{ id: "1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" }] };
    // G1: tracker trong engine — feed 2 batch giống hệt nhau (repeat = 2).
    await eng.evaluate(baseCtx({ hasToolCalls: true, message: calls }));
    await eng.evaluate(baseCtx({ hasToolCalls: true, message: calls }));
    const ds = await eng.evaluate(baseCtx({ hasToolCalls: true, message: calls }));
    const d = ds.find((x) => x.rule === "doom-loop");
    assert.ok(d);
    assert.equal(d.action.kind, "inject");
    assert.ok(d.action.reminder.includes("loop"));
    // Đổi batch → repeat reset, không kích hoạt
    const eng2 = new GuardrailEngine();
    const other = { role: "assistant", content: null, tool_calls: [{ id: "1", name: "list_files", arguments: "{}" }] };
    await eng2.evaluate(baseCtx({ hasToolCalls: true, message: calls }));
    await eng2.evaluate(baseCtx({ hasToolCalls: true, message: calls }));
    await eng2.evaluate(baseCtx({ hasToolCalls: true, message: other }));
    assert.ok(!(await eng2.evaluate(baseCtx({ hasToolCalls: true, message: other }))).find((x) => x.rule === "doom-loop"));
  });

  it("build-stop: tool chạy đúng build command thành công → finish; thất bại → verify-build", async () => {
    const eng = new GuardrailEngine();
    const ok = await eng.evaluate(
      baseCtx({ hasToolCalls: true, buildCallPresent: true, buildPassedThisStep: true, filesModified: true, text: "Fixed it" }),
    );
    const dOk = ok.find((x) => x.rule === "build-stop");
    assert.ok(dOk);
    assert.equal(dOk.action.kind, "finish");
    assert.equal(dOk.action.summary, "Fixed it");

    const fail = await eng.evaluate(
      baseCtx({ hasToolCalls: true, buildCallPresent: true, buildPassedThisStep: false }),
    );
    const dFail = fail.find((x) => x.rule === "build-stop");
    assert.ok(dFail);
    assert.equal(dFail.action.kind, "verify-build");
  });

  it("wrap-up: cách N bước hết budget → inject reminder đúng một lần", async () => {
    const eng = new GuardrailEngine();
    const n = DEFAULT_GUARDRAIL_OPTIONS.wrapUpStepsBeforeEnd;
    const ds = await eng.evaluate(baseCtx({ step: 38, maxSteps: 40 }));
    const d = ds.find((x) => x.rule === "wrap-up");
    assert.ok(d, "phải inject khi còn 2 bước");
    assert.equal(d.action.kind, "inject");
    // Đã inject rồi thì không lặp lại — markWrapUpInjected (G1) là state engine
    eng.markWrapUpInjected();
    const again = await eng.evaluate(baseCtx({ step: 38, maxSteps: 40 }));
    assert.ok(!again.find((x) => x.rule === "wrap-up"));
    // Còn nhiều bước thì chưa
    const early = await eng.evaluate(baseCtx({ step: 10, maxSteps: 40 }));
    assert.ok(!early.find((x) => x.rule === "wrap-up"));
    assert.equal(n, 2);
  });

  it("history-trim: luôn yêu cầu trim context sau mỗi bước", async () => {
    const eng = new GuardrailEngine();
    const ds = await eng.evaluate(baseCtx());
    const d = ds.find((x) => x.rule === "history-trim");
    assert.ok(d);
    assert.equal(d.action.kind, "trim");
  });

  it("ngưỡng cấu hình được qua GuardrailOptions (không sửa runLoop)", async () => {
    const eng = createGuardrailEngine({ textOnlyStreakLimit: 5 });
    for (let i = 1; i <= 5; i++) await eng.evaluate(baseCtx({ text: "hi", step: i }));
    const at5 = await eng.evaluate(baseCtx({ text: "hi", step: 5 }));
    assert.ok(at5.find((x) => x.rule === "text-only-streak"), "streak 5 phải dừng");
    // Ngưỡng 2 mặc định: streak 2 dừng, streak 1 chưa
    const eng2 = createGuardrailEngine();
    const s1 = await eng2.evaluate(baseCtx({ text: "hi", step: 1 }));
    assert.ok(!s1.find((x) => x.rule === "text-only-streak"), "streak 1 chưa dừng");
    const s2 = await eng2.evaluate(baseCtx({ text: "hi", step: 2 }));
    assert.ok(s2.find((x) => x.rule === "text-only-streak"), "streak 2 phải dừng");
  });

  it("thứ tự ưu tiên: chat-done đứng trước continue-nudge (không nudge lượt chat)", async () => {
    const eng = new GuardrailEngine();
    const ds = await eng.evaluate(baseCtx({ text: "hi there", chatDone: true }));
    const names = ds.map((x) => x.rule);
    assert.ok(names.includes("chat-done"));
    assert.ok(!names.includes("continue-nudge"), "lượt chat không được nudge");
    assert.ok(names.indexOf("chat-done") < names.indexOf("history-trim"));
  });

  it("onDecision callback: mỗi rule kích hoạt đều được log", async () => {
    const logged = [];
    const eng = new GuardrailEngine(undefined, (d) => logged.push(d));
    await eng.evaluate(baseCtx({ text: "The task is now complete", filesModified: true }));
    assert.ok(logged.some((d) => d.rule === "completion-claim"));
    assert.ok(logged.every((d) => d.rule && d.reason && d.action.kind));
  });

  it("rule lỗi (throw) không làm gãy engine — trả decision none", async () => {
    const eng = new GuardrailEngine([
      {
        name: "broken",
        description: "always throws",
        evaluate() {
          throw new Error("boom");
        },
      },
    ]);
    const ds = await eng.evaluate(baseCtx());
    const d = ds.find((x) => x.rule === "broken");
    assert.ok(d);
    assert.equal(d.action.kind, "none");
  });

  it("register: thêm rule tùy chỉnh chạy cùng rule mặc định", async () => {
    const eng = createGuardrailEngine();
    eng.register({
      name: "custom-never-say-never",
      description: "test rule",
      evaluate(ctx) {
        return ctx.text.includes("forbidden") ? { action: { kind: "finish", success: false, summary: "blocked" }, reason: "test" } : null;
      },
    });
    const hit = await eng.evaluate(baseCtx({ text: "this is forbidden" }));
    assert.ok(hit.find((x) => x.rule === "custom-never-say-never"));
    const quiet = await eng.evaluate(baseCtx({ text: "all good" }));
    assert.ok(!quiet.find((x) => x.rule === "custom-never-say-never"));
  });

  it("reset (G1): tracker per-run — run mới không kế thừa streak của run cũ", async () => {
    const eng = new GuardrailEngine();
    await eng.evaluate(baseCtx({ text: "a", step: 1 }));
    await eng.evaluate(baseCtx({ text: "b", step: 2 }));
    eng.reset();
    const fresh = await eng.evaluate(baseCtx({ text: "c", step: 1 }));
    assert.ok(!fresh.find((x) => x.rule === "text-only-streak"), "streak phải về 0 sau reset");
  });

  it("notifySteered (G1): steer batch reset text-only allowance", async () => {
    const eng = new GuardrailEngine();
    await eng.evaluate(baseCtx({ text: "a", step: 1 }));
    eng.notifySteered();
    const after = await eng.evaluate(baseCtx({ text: "b", step: 2 }));
    assert.ok(!after.find((x) => x.rule === "text-only-streak"), "streak reset sau steer");
  });

  it("error-loop (G1): tracker tính từ toolResults trong ctx", async () => {
    const eng = new GuardrailEngine();
    const calls = { role: "assistant", content: null, tool_calls: [{ id: "t1", name: "run_command", arguments: "{\"command\":\"x\"}" }] };
    const results = new Map([["t1", { ok: false, output: "ERROR: module not found" }]]);
    const ctx = () => baseCtx({ hasToolCalls: true, message: calls, toolResults: results });
    await eng.evaluate(ctx());
    await eng.evaluate(ctx());
    const hit = await eng.evaluate(ctx());
    const d = hit.find((x) => x.rule === "error-loop");
    assert.ok(d, "cùng tool+error 3 lần phải inject");
    assert.equal(d.action.kind, "inject");
  });
});
