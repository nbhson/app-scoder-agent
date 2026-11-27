/**
 * Unit tests cho rule `stale-answer` (guardrails.ts) — lỗi thật ghi trong
 * ~/.scoder/sessions:
 *   - 20261127-104714-602d / 20261127-105851-7fb8: run fetch 6 step rồi KẾT THÚC
 *     bằng đúng câu chào của lượt đầu tiên (success:true) ⇒ user "không nhận
 *     được đáp án cho yêu cầu hiện tại";
 *   - 20261127-103715-f250: ba lượt cuối cắt giữa câu — 93 → 26 → 4 ký tự
 *     ("Dưới", outputTokens:3) — vẫn được báo success:true.
 *
 * Rule phải: (1) cho model CƠ HỘI nữa (inject), (2) nếu vẫnDegenerate thì báo
 * THẤT BẠI kèm đáp án tốt nhất tìm được, thay vì nhận vơ text cụt làm kết quả.
 *
 * Chạy: npm run build && node --test test/guardrails-degenerate.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GuardrailEngine,
  CHAT_DONE_MARKER,
  looksTruncated,
  degenerateAnswer,
} from "../dist/agent/guardrails.js";

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
  planOpen: false,
  ...over,
});

const FULL_GREETING = "Chào bạn! 👋 Nếu bạn cần giúp gì với code hoặc dự án, cứ nói nhé.";
const LONG_ANSWER =
  "Dưới đây là các tính năng mới nhất của Angular: signals ở dạng stable, " +
  "effect(), @if/@for control flow, và contextual injection trong v20.";

describe("looksTruncated — phát hiện đáp án bị cắt giữa câu", () => {
  it("cụt rõ ràng → true (quá ngắn, hoặc mở đầu chưa nối tiếp)", () => {
    assert.equal(looksTruncated("Dưới"), true);
    assert.equal(looksTruncated("Đây là bảng so sánh:"), true);
    assert.equal(looksTruncated("Và:"), true);
  });
  it("một dòng ngắn không dấu câu thì CHƯA đủ là bằng chứng — cần tín hiệu lịch sử", () => {
    // "Mình là Scoder, agent lập trình" / "Đây là 3 option bạn nhé" là đáp án hợp lệ;
    // gọi chúng là "cụt" sẽ đốt thêm 1 LLM call cho mỗi lượt chat.
    assert.equal(looksTruncated("Hiểu rồi! Bạn muốn câu dài"), false);
    assert.equal(looksTruncated("Mình là Scoder, agent lập trình"), false);
    assert.equal(looksTruncated("Đây là 3 option bạn nhé"), false);
  });
  it("có dấu chấm câu / xuống dòng danh sách → false", () => {
    assert.equal(looksTruncated(FULL_GREETING), false);
    assert.equal(looksTruncated(LONG_ANSWER), false);
    assert.equal(looksTruncated("Tóm lại:\n- đã xong phần A\n- còn phần B"), false);
  });
  it("câu xác nhận ngắn hợp lệ → false (không lãng phí 1 LLM call)", () => {
    for (const ack of ["Xong", "OK", "okay", "được rồi", "vâng ạ", "cảm ơn bạn", "done"]) {
      assert.equal(looksTruncated(ack), false, `ack phải không bị coi là cụt: ${ack}`);
    }
  });
  it("rỗng → false (rule khác lo)", () => {
    assert.equal(looksTruncated(""), false);
    assert.equal(looksTruncated("   "), false);
  });
});

describe("degenerateAnswer — echo/lặp của câu trả lời trước đó", () => {
  const prior = [FULL_GREETING, LONG_ANSWER];

  it("văn bản là PREFIX chặt của một câu trả lời trước ⇒ model chết giữa câu cũ", () => {
    const d = degenerateAnswer("Dưới", prior, 0);
    assert.ok(d, "phải phát hiện");
    assert.equal(d.kind, "restarted-answer");
  });

  it("lặp NGUYÊN VĂN câu chào sau khi đã chạy tool ⇒ câu trả lời sai", () => {
    const d = degenerateAnswer(FULL_GREETING, [FULL_GREETING], 6);
    assert.ok(d);
    assert.equal(d.kind, "stale-echo");
  });

  it("lặp nguyên văn nhưng run không dùng tool ⇒ lượt chat thường (hợp lệ)", () => {
    assert.equal(degenerateAnswer(FULL_GREETING, [FULL_GREETING], 0), null);
  });

  it("đáp án mới, đủ dài → null", () => {
    assert.equal(degenerateAnswer(LONG_ANSWER, [FULL_GREETING], 6), null);
  });
});

describe("stale-answer rule", () => {
  it("can thiệp đầu tiên: inject cho model cơ hội trả lời lại", async () => {
    const eng = new GuardrailEngine();
    const ds = await eng.evaluate(
      baseCtx({ step: 7, text: FULL_GREETING, priorAssistantTexts: [FULL_GREETING], toolsUsedThisRun: 6 }),
    );
    const d = ds.find((x) => x.rule === "stale-answer");
    assert.ok(d, "echo sau khi chạy tool phải bị chặn");
    assert.equal(d.action.kind, "inject");
    assert.match(d.action.reminder, /current request/i);
    assert.ok(d.action.reminder.includes(CHAT_DONE_MARKER), "phải chỉ đường thoát chat-done");
  });

  it("vẫn degenerate sau khi đã nhắc: finish success:false + đáp án tốt nhất", async () => {
    const eng = new GuardrailEngine();
    const ctx = baseCtx({
      step: 8,
      text: "Dưới",
      priorAssistantTexts: [LONG_ANSWER],
      lastSubstantiveAnswer: LONG_ANSWER,
    });
    await eng.evaluate(ctx);
    eng.markDegenerateIntervention();
    const ds = await eng.evaluate({ ...ctx, step: 9 });
    const d = ds.find((x) => x.rule === "stale-answer");
    assert.ok(d);
    assert.equal(d.action.kind, "finish");
    assert.equal(d.action.success, false, "không được báo success với đáp án cụt");
    assert.ok(d.action.summary.includes(LONG_ANSWER), `summary phải cứu đáp án cũ: ${d.action.summary}`);
    // rule đứng TRƯỚC text-only-streak ⇒ decision của nó mới là finish được áp dụng
    const firstFinish = ds.find((x) => x.action.kind === "finish");
    assert.equal(firstFinish.rule, "stale-answer");
  });

  it("đáp án bình thường: rule im lặng, lượt chat vẫn finish 1 call (P0-8)", async () => {
    const eng = new GuardrailEngine();
    const ds = await eng.evaluate(baseCtx({ text: FULL_GREETING }));
    assert.ok(!ds.find((x) => x.rule === "stale-answer"), "câu chào hợp lệ không bị chặn");
    const nudge = ds.find((x) => x.rule === "continue-nudge");
    assert.equal(nudge.action.kind, "finish");
    assert.equal(nudge.action.chatOnly, true);
  });

  it("bước có tool call: rule không can thiệp", async () => {
    const eng = new GuardrailEngine();
    const calls = { role: "assistant", content: "Dưới", tool_calls: [{ id: "1", name: "read_file", arguments: '{"path":"a.ts"}' }] };
    const ds = await eng.evaluate(baseCtx({ hasToolCalls: true, message: calls, text: "Dưới", priorAssistantTexts: [LONG_ANSWER] }));
    assert.ok(!ds.find((x) => x.rule === "stale-answer"));
  });

  it("reset() giữa hai run — không mang theo số lần can thiệp", async () => {
    const eng = new GuardrailEngine();
    const ctx = baseCtx({ text: "Dưới", priorAssistantTexts: [LONG_ANSWER] });
    await eng.evaluate(ctx);
    eng.markDegenerateIntervention();
    eng.reset();
    const ds = await eng.evaluate(ctx);
    const d = ds.find((x) => x.rule === "stale-answer");
    assert.equal(d.action.kind, "inject", "run mới phải bắt đầu lại ở bậc nhắc");
  });
});
