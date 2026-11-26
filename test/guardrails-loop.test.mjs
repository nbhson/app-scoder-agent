/**
 * Unit tests cho bộ dò doom-loop mới (guardrails.ts) + cache chống lặp
 * (loop-cache.ts). Bối cảnh: model local (ornith-1.5:35b qua proxy) lặp theo CHU
 * KỲ "gọi lệnh → phân tích → fetch" chứ không lặp y hệt một batch liên tiếp, nên
 * detector cũ (chỉ so batch với bước liền trước, so nguyên văn chuỗi JSON) không
 * bao giờ kích hoạt — run đốt hết maxSteps mà không có kết quả cuối.
 *
 * Chạy: npm run build && node --test test/guardrails-loop.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GuardrailEngine, createGuardrailEngine, detectCycle } from "../dist/agent/guardrails.js";
import { batchSignature, callSignature, normalizeToolArgs } from "../dist/agent/tool-signature.js";
import { LoopCallCache } from "../dist/agent/loop-cache.js";

const baseCtx = (over = {}) => ({
  step: 1,
  maxSteps: 40,
  text: "",
  message: null,
  hasToolCalls: true,
  buildPassedThisStep: false,
  buildCallPresent: false,
  filesModified: false,
  chatDone: false,
  planOpen: false,
  ...over,
});

/** batch 1 tool call: { name, args } → AssistantMessage giả lập. */
const msg = (calls) => ({
  role: "assistant",
  content: null,
  tool_calls: calls.map((c, i) => ({ id: `c${i}`, name: c[0], arguments: typeof c[1] === "string" ? c[1] : JSON.stringify(c[1]) })),
});

const doom = (decisions) => decisions.find((d) => d.rule === "doom-loop");

describe("normalizeToolArgs — chữ ký không phụ thuộc cách model in JSON", () => {
  it("thứ tự key và khoảng trắng không đổi chữ ký", () => {
    const a = callSignature("read_file", '{"path":"a.ts","offset":10}');
    const b = callSignature("read_file", '{ "offset" : 10, "path" : "a.ts" }');
    assert.equal(a, b);
  });
  it("args khác nhau vẫn cho chữ ký khác nhau", () => {
    assert.notEqual(callSignature("read_file", '{"path":"a.ts"}'), callSignature("read_file", '{"path":"b.ts"}'));
  });
  it("JSON hỏng: vẫn chuẩn hoá khoảng trắng thừa", () => {
    assert.equal(normalizeToolArgs('{"path":   "a.ts"'), normalizeToolArgs('{"path":      "a.ts"'));
  });
  it("batch signature bỏ qua tool_call id (provider sinh id ngẫu nhiên)", () => {
    const s1 = batchSignature([{ id: "x1", name: "grep", arguments: '{"pattern":"a"}' }]);
    const s2 = batchSignature([{ id: "zz", name: "grep", arguments: '{"pattern": "a"}' }]);
    assert.equal(s1, s2);
  });
  it("args rỗng/undefined không làm rule crash", () => {
    assert.equal(typeof callSignature("list_files", undefined), "string");
    assert.equal(normalizeToolArgs(""), "");
  });
});

describe("detectCycle — nhận diện loop có kỳ", () => {
  it("phát hiện chu kỳ 2 (A,B,A,B)", () => {
    assert.deepEqual(detectCycle(["A", "B", "A", "B"]), { period: 2, repeats: 2 });
  });
  it("phát hiện chu kỳ 3 (A,B,C,A,B,C)", () => {
    assert.deepEqual(detectCycle(["A", "B", "C", "A", "B", "C"]), { period: 3, repeats: 2 });
  });
  it("đếm số vòng lặp lại", () => {
    assert.deepEqual(detectCycle(["A", "B", "A", "B", "A", "B", "A", "B"]), { period: 2, repeats: 4 });
  });
  it("period 1 (batch giống hệt) KHÔNG tính là cycle — streak lo", () => {
    assert.equal(detectCycle(["A", "A", "A"]), null);
  });
  it("chưa đủ 2 vòng thì chưa phải cycle", () => {
    assert.equal(detectCycle(["A", "B", "A"]), null);
  });
  it("khối khác nhau ở bước cuối thì không phải cycle", () => {
    assert.equal(detectCycle(["A", "B", "C", "A", "B", "D"]), null);
  });
});

describe("doom-loop — ba tín hiệu + bậc thang", () => {
  it("cycle A→B→A→B (loop có kỳ) bị bắt, reminder nói rõ là loop", async () => {
    const eng = new GuardrailEngine();
    const readA = msg([["read_file", { path: "a.ts" }]]);
    const grepB = msg([["grep", { pattern: "foo" }]]);
    await eng.evaluate(baseCtx({ step: 1, message: readA }));
    await eng.evaluate(baseCtx({ step: 2, message: grepB }));
    await eng.evaluate(baseCtx({ step: 3, message: readA }));
    const ds = await eng.evaluate(baseCtx({ step: 4, message: grepB }));
    const d = doom(ds);
    assert.ok(d, "phải phát hiện chu kỳ lặp");
    assert.equal(d.action.kind, "inject");
    assert.match(d.action.reminder, /loop/);
    assert.match(d.reason, /period 2/);
  });

  it("lặp rải rác (cùng call, xen lệnh khác) vẫn bị bắt", async () => {
    const eng = new GuardrailEngine();
    const readA = msg([["read_file", { path: "a.ts" }]]);
    const steps = [
      msg([["list_files", { path: "src" }]]),
      msg([["glob", { pattern: "**/*.ts" }]]),
      readA,
      msg([["grep", { pattern: "x" }]]),
      readA,
      msg([["repo_map", {}]]),
      readA,
      msg([["grep", { pattern: "y" }]]),
      readA, // lần 4 của cùng một lệnh đọc
    ];
    let hit = null;
    for (let i = 0; i < steps.length; i++) {
      hit = doom(await eng.evaluate(baseCtx({ step: i + 1, message: steps[i] }))) ?? hit;
    }
    assert.ok(hit, "scattered repeat phải kích hoạt");
    assert.match(hit.reason, /read-only call ran 4x/);
  });

  it("can thiệp lần 2 (hoặc pattern quá sâu) ⇒ finish kèm kết quả cuối", async () => {
    const eng = new GuardrailEngine();
    const a = msg([["read_file", { path: "a.ts" }]]);
    const b = msg([["grep", { pattern: "foo" }]]);
    const feed = async (step, message, text) => await eng.evaluate(baseCtx({ step, message, text }));
    await feed(1, a);
    await feed(2, b);
    await feed(3, a);
    const first = doom(await feed(4, b, "Tôi đang tìm điểm vào ứng dụng."));
    assert.equal(first.action.kind, "inject");
    eng.markLoopIntervention(); // runLoop gọi khi áp dụng inject
    const second = doom(await feed(5, a, "Cần đọc lại file để chắc chắn."));
    assert.equal(second.action.kind, "finish");
    assert.equal(second.action.success, false);
    assert.match(second.action.summary, /loop/i);
    assert.match(second.action.summary, /Cần đọc lại file/, "summary phải mang câu trả lời cuối");
  });

  it("streak sâu (batch giống hệt 4 lần liên tiếp) finish ngay, không chờ nhắc", async () => {
    const eng = new GuardrailEngine();
    const a = msg([["read_file", { path: "a.ts" }]]);
    await eng.evaluate(baseCtx({ message: a }));
    await eng.evaluate(baseCtx({ message: a }));
    const first = doom(await eng.evaluate(baseCtx({ message: a })));
    assert.equal(first.action.kind, "inject");
    const second = doom(await eng.evaluate(baseCtx({ message: a })));
    assert.equal(second.action.kind, "finish");
  });

  it("JSON lệch hình thức vẫn bị tính là lặp (regression: detector cũ mù)", async () => {
    const eng = new GuardrailEngine();
    const variants = ['{"path":"a.ts"}', '{ "path" : "a.ts" }', '{"path":  "a.ts"}'];
    for (let i = 0; i < 3; i++) {
      const ds = await eng.evaluate(baseCtx({ step: i + 1, message: msg([["read_file", variants[i]]]) }));
      if (i < 2) assert.equal(doom(ds), undefined, `chưa tới ngưỡng ở bước ${i + 1}`);
      else assert.ok(doom(ds), "lần thứ 3 (dù JSON khác nhau) phải bị bắt");
    }
  });

  it("công việc thật (mỗi bước một args khác nhau) không bị nghi ngờ", async () => {
    const eng = new GuardrailEngine();
    const seq = [
      msg([["read_file", { path: "a.ts" }]]),
      msg([["read_file", { path: "b.ts" }]]),
      msg([["grep", { pattern: "alpha" }]]),
      msg([["edit_file", { path: "a.ts", content: "x" }]]),
      msg([["run_command", { command: "npm test" }]]),
      msg([["run_command", { command: "npm test" }]]), // verify lại sau khi sửa ⇒ hợp lệ
      msg([["grep", { pattern: "beta" }]]),
      msg([["read_file", { path: "c.ts" }]]),
    ];
    for (let i = 0; i < seq.length; i++) {
      const ds = await eng.evaluate(baseCtx({ step: i + 1, message: seq[i], filesModified: i >= 3 }));
      assert.equal(doom(ds), undefined, `bước ${i + 1} không được kích hoạt doom-loop: ${JSON.stringify(doom(ds))}`);
    }
  });

  it("build lặp lại (run_command) không được tính vào scattered counter", async () => {
    const eng = new GuardrailEngine();
    const build = msg([["run_command", { command: "npm test" }]]);
    const others = [
      msg([["read_file", { path: "a.ts" }]]),
      msg([["grep", { pattern: "1" }]]),
      msg([["read_file", { path: "b.ts" }]]),
      msg([["grep", { pattern: "2" }]]),
      msg([["read_file", { path: "c.ts" }]]),
    ];
    const seq = [];
    for (const o of others) seq.push(build, o);
    seq.push(build);
    for (let i = 0; i < seq.length; i++) {
      const ds = await eng.evaluate(baseCtx({ step: i + 1, message: seq[i], filesModified: true }));
      assert.equal(doom(ds), undefined, `lệnh build lặp lại không phải doom-loop: ${JSON.stringify(doom(ds))}`);
    }
  });

  it("step không có tool call thì rule im lặng", async () => {
    const eng = createGuardrailEngine({ doomLoopRepeats: 1 });
    const ds = await eng.evaluate(baseCtx({ hasToolCalls: false, message: null }));
    assert.equal(doom(ds), undefined);
  });
});

describe("LoopCallCache — cache kết quả tool đọc", () => {
  it("key chuẩn hoá: args lệch khoảng trắng/tráo key vẫn trùng", () => {
    const c = new LoopCallCache();
    const k1 = c.keyFor("read_file", '{"path":"a.ts","offset":2}');
    const k2 = c.keyFor("read_file", '{ "offset" : 2, "path" : "a.ts" }');
    assert.equal(k1, k2);
  });

  it("record rồi lookup ⇒ trả đúng output và step gốc", () => {
    const c = new LoopCallCache();
    c.record(c.keyFor("grep", '{"pattern":"x"}'), 3, { ok: true, output: "a.ts:1: x" });
    const hit = c.lookup(c.keyFor("grep", '{ "pattern": "x" }'));
    assert.ok(hit);
    assert.equal(hit.step, 3);
    assert.equal(hit.output, "a.ts:1: x");
    assert.equal(c.hits, 1);
  });

  it("kết quả lỗi không được cache (phải được thử lại thật)", () => {
    const c = new LoopCallCache();
    c.record("k", 1, { ok: false, output: "ERROR: timeout" });
    assert.equal(c.lookup("k"), null);
  });

  it("invalidate (tool biến đổi chạy) ⇒ mất hết entry", () => {
    const c = new LoopCallCache();
    c.record("k", 1, { ok: true, output: "x" });
    c.invalidate("run_command");
    assert.equal(c.lookup("k"), null);
    assert.equal(c.lastInvalidatedReason, "run_command");
    assert.equal(c.size(), 0);
  });

  it("reset (run mới) ⇒ xoá cả hits lẫn entries", () => {
    const c = new LoopCallCache();
    c.record("k", 1, { ok: true, output: "x" });
    c.lookup("k");
    c.reset();
    assert.equal(c.size(), 0);
    assert.equal(c.hits, 0);
  });

  it("không ghi đè lần đầu và có trần FIFO", () => {
    const c = new LoopCallCache();
    c.record("k", 1, { ok: true, output: "first" });
    c.record("k", 9, { ok: true, output: "second" });
    assert.equal(c.lookup("k").output, "first");
    for (let i = 0; i < 70; i++) c.record(`k${i}`, i, { ok: true, output: `o${i}` });
    assert.ok(c.size() <= 64, `size ${c.size()} phải <= 64`);
  });
});
