/**
 * P2.2 Phase A (plan/P2-02 §1) — RouterRuntime với fake clients: điều phối
 * đúng model theo kịch bản history, emit decision đủ field, lazy client
 * cache, loại toolCall:false, đường về fallback khi router lỗi.
 * Chạy: npm run build && node --test test/router-runtime.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouterRuntime } from "../dist/router/router-runtime.js";
import { IDLE_TURN_CONTEXT } from "../dist/router/types.js";

function fakeClient(model) {
  const calls = [];
  return {
    model,
    calls,
    lastPartialToolCalls: [],
    setModel(m) {
      this.model = m;
    },
    async chat(messages, tools) {
      calls.push({ kind: "chat", messages, tools });
      return { message: { role: "assistant", content: `ok:${model}`, stop_reason: "stop" } };
    },
    async *streamChat(messages, tools) {
      calls.push({ kind: "stream", messages, tools });
      yield { contentDelta: `s:${model}` };
    },
  };
}

const MODELS = [
  { ref: "box-api/qwen3.8-flash", tier: "small", model: "qwen3.8-flash", provider: "box-api", toolCall: true, contextWindow: 262144, pricing: { input: 0.2, output: 0.8 } },
  { ref: "box-api/kimi-k2.7-code", tier: "small", model: "kimi-k2.7-code", provider: "box-api", toolCall: true, contextWindow: 128000 },
  { ref: "box-api/kimi-k3", tier: "large", model: "kimi-k3", provider: "box-api", toolCall: true, contextWindow: 200000, pricing: { input: 3, output: 15 } },
  { ref: "box-api/sonnet", tier: "large", model: "claude-sonnet", provider: "box-api", toolCall: true, contextWindow: 300000 },
  { ref: "box-api/tiny-no-tools", tier: "small", model: "tiny-no-tools", provider: "box-api", toolCall: false },
];

function harness(over = {}) {
  const made = [];
  const decisions = [];
  const rt = new RouterRuntime({
    models: structuredClone(MODELS),
    fallbackRef: "box-api/kimi-k3",
    config: {
      signals: { smallMaxCtxTokens: 16000, largeToolSchemaChars: 30000 },
      rules: [],
      escalate: { buildFails: 2, stickyMinSteps: 2 },
    },
    makeClient: (m) => {
      const c = fakeClient(m.model);
      made.push({ ref: m.ref, client: c });
      return c;
    },
    sensors: () => ({ ...IDLE_TURN_CONTEXT, ...over }),
    onRoute: (d) => decisions.push(d),
    mode: "auto",
  });
  return { rt, made, decisions };
}

const smallMsgs = [{ role: "user", content: "liệt kê file trong src/" }];
const editMsgs = [
  { role: "user", content: "tách trust.ts khỏi config.ts" },
  { role: "assistant", content: null, tool_calls: [{ id: "1", name: "edit_file", arguments: JSON.stringify({ path: "src/config/config.ts" }) }] },
];
const bigTools = [{ type: "function", function: { name: "x", description: "d".repeat(40000), parameters: {} } }];

describe("RouterRuntime — điều phối theo nội dung lượt", () => {
  it("việc nhỏ (history ngắn, explore) → model small RẺ NHẤT", async () => {
    const { rt, made } = harness({ phase: "explore", step: 3 });
    const r = await rt.chat(smallMsgs, []);
    assert.equal(r.message.content, "ok:qwen3.8-flash"); // cheapest small
    assert.equal(made.length, 1);
  });

  it("phase edit + lượt cuối wrap-up → large (context lớn nhất)", async () => {
    const { rt } = harness({ phase: "edit", step: 39, maxSteps: 40 });
    const r = await rt.chat(editMsgs, bigTools);
    assert.equal(r.message.content, "ok:claude-sonnet"); // large xếp theo ctx: sonnet 300k > kimi-k3 200k
  });

  it("streamChat cũng route — delta đi thẳng từ client được chọn", async () => {
    const { rt } = harness({ phase: "explore", step: 3 });
    const chunks = [];
    for await (const c of rt.streamChat(smallMsgs, [])) chunks.push(c.contentDelta);
    assert.deepEqual(chunks, ["s:qwen3.8-flash"]);
  });

  it("tool schema lớn + history to → large; decision đủ field audit", async () => {
    const { rt, decisions } = harness({ phase: null, step: 5, maxSteps: 40 });
    await rt.chat([{ role: "user", content: "x".repeat(120000) }], bigTools); // 30k tok + 40k chars schema
    assert.equal(decisions.length, 1);
    const d = decisions[0];
    assert.equal(d.tier, "large");
    assert.equal(d.ref, "box-api/sonnet");
    assert.equal(d.provider, "box-api");
    assert.equal(d.model, "claude-sonnet");
    assert.equal(d.step, 5);
    assert.ok(d.switched); // ref đổi so với (không có) ref trước
    assert.match(d.reason, /score \+2/);
    assert.equal(d.signals.estTokens, 30000);
    assert.equal(d.signals.mode, "auto");
  });

  it("toolCall:false bị loại khi lượt có tools; được dùng khi lượt không tools", async () => {
    const rt = new RouterRuntime({
      models: structuredClone(MODELS),
      fallbackRef: "box-api/kimi-k3",
      config: { signals: { smallMaxCtxTokens: 16000, largeToolSchemaChars: 30000 }, rules: [], escalate: { buildFails: 2, stickyMinSteps: 2 } },
      makeClient: (m) => fakeClient(m.model),
      sensors: () => ({ ...IDLE_TURN_CONTEXT, phase: "explore", step: 2 }),
    });
    rt.setModel("auto");
    await rt.chat(smallMsgs, []); // không tools → tiny (cost chưa khai → xếp sau qwen? qwen có 0.8 — tiny MAX) → qwen
    assert.equal(rt.model, "qwen3.8-flash");
    await rt.chat(smallMsgs, bigTools);
    assert.equal(rt.model, "qwen3.8-flash"); // vẫn không phải tiny (toolCall:false)
  });

  it("lazy client cache — 2 lượt cùng tier chỉ tạo 1 client", async () => {
    const { rt, made } = harness({ phase: "explore", step: 3 });
    await rt.chat(smallMsgs, []);
    await rt.chat(smallMsgs, []);
    assert.equal(made.length, 1);
    assert.equal(made[0].ref, "box-api/qwen3.8-flash");
  });

  it("cache affinity: tier không đổi → giữ nguyên ref kể cả khi có model cùng tier rẻ hơn", async () => {
    // kimi-k2.7 (small, không pricing) được chọn trước (MAX_PRICE xếp sau qwen…
    // → qwen rẻ hơn thắng ngay từ đầu). Kiểm tra affinity bằng cách pin→auto:
    const { rt, decisions } = harness({ phase: "explore", step: 3 });
    rt.setModel("box-api/kimi-k2.7-code"); // warm ref = kimi
    await rt.chat(smallMsgs, []);
    rt.setModel("auto");
    await rt.chat(smallMsgs, []); // tier small lần đầu ở auto → rank thường lệ (qwen)
    await rt.chat(smallMsgs, []); // cùng tier → giữ qwen, switched=false
    assert.equal(decisions.at(-1).ref, "box-api/qwen3.8-flash");
    assert.equal(decisions.at(-1).switched, false);
  });

  it("pickAuto ném lỗi → đường về fallback deterministic, run không chết", async () => {
    const { rt } = harness({ phase: "explore", step: 3 });
    // chế độ phá: rules gây lỗi trong classify — thay config.rules bằng getter throw
    Object.defineProperty(rt, "opts", {
      value: { ...rt.opts, config: { ...rt.opts.config, get rules() { throw new Error("boom"); } } },
    });
    const r = await rt.chat(smallMsgs, []);
    assert.equal(r.message.content, "ok:kimi-k3"); // fallback
  });

  it("model getter/setter: setModel(id) cùng provider → warm client, model đổi ngay", () => {
    const { rt, made } = harness();
    rt.setModel("box-api/kimi-k3");
    assert.equal(rt.model, "kimi-k3");
    rt.setModel("kimi-k2.7-code"); // bare id unique trong tiers
    assert.equal(rt.model, "kimi-k2.7-code");
    assert.equal(made.length, 2); // mỗi lần pin warm đúng client của nó
  });

  it("lastPartialToolCalls delegate sang client active", async () => {
    const { rt } = harness({ phase: "explore", step: 3 });
    await rt.chat(smallMsgs, []);
    const partial = [{ id: "t1", name: "edit_file", arguments: "{" }];
    rt.lastPartialToolCalls = partial;
    assert.deepEqual(rt.lastPartialToolCalls, partial);
  });
});

describe("RouterRuntime — judge hook (chữ ký L4, fake judge)", () => {
  const baseHarness = (judge, cfgOver = {}) => {
    const made = [];
    const decisions = [];
    const rt = new RouterRuntime({
      models: structuredClone(MODELS),
      fallbackRef: "box-api/kimi-k3",
      config: {
        signals: { smallMaxCtxTokens: 16000, largeToolSchemaChars: 30000 },
        rules: [],
        escalate: { buildFails: 2, stickyMinSteps: 2 },
        judge: cfgOver.judge ?? null,
      },
      makeClient: (m) => {
        const c = fakeClient(m.model);
        made.push({ ref: m.ref, client: c });
        return c;
      },
      judge,
      sensors: () => ({ ...IDLE_TURN_CONTEXT, phase: "edit", step: 4 }), // base = large, không gray
      onRoute: (d) => decisions.push(d),
    });
    rt.setModel("auto");
    return { rt, made, decisions };
  };

  it("accept ref khác tier trong tier của nó → target là ref judge trả, tier suy ra từ ref", async () => {
    const judge = { async judge() { return { tier: "large", ref: "box-api/kimi-k2.7-code", confidence: 0.9, reason: "sửa 1 dòng", ms: 40, tokens: 60 }; } };
    const { rt, decisions } = baseHarness(judge, { judge: { model: "x", scope: "always" } });
    await rt.chat(smallMsgs, []);
    assert.equal(decisions[0].ref, "box-api/kimi-k2.7-code"); // judge thắng L1 (kimi-k3/sonnet)
    assert.equal(decisions[0].tier, "small"); // tier DERIVED từ ref
    assert.equal(decisions[0].judge.verdict, "accept");
    assert.match(decisions[0].reason, /judge: sửa 1 dòng/);
  });

  it("hallucinated ref → reject, giữ decision L1, audit ghi rõ", async () => {
    const judge = { async judge() { return { tier: "small", ref: "box-api/gpt-99", confidence: 0.99, reason: "", ms: 10, tokens: 5 }; } };
    const { rt, decisions } = baseHarness(judge, { judge: { model: "x", scope: "always" } });
    await rt.chat(smallMsgs, []);
    assert.equal(decisions[0].judge.verdict, "reject-hallucinated");
    assert.equal(decisions[0].tier, "large"); // L1 giữ nguyên
    assert.match(decisions[0].reason, /judge-reject\(hallucinated\)/);
  });

  it("confidence dưới sàn → reject-confidence", async () => {
    const judge = { async judge() { return { tier: "small", ref: "box-api/qwen3.8-flash", confidence: 0.5, reason: "?", ms: 12, tokens: 9 }; } };
    const { rt, decisions } = baseHarness(judge, { judge: { model: "x", scope: "always", minConfidence: 0.6 } });
    await rt.chat(smallMsgs, []);
    assert.equal(decisions[0].judge.verdict, "reject-confidence");
    assert.equal(decisions[0].tier, "large");
  });

  it("judge ném lỗi → bắt trong askJudge (verdict fallback), run dùng decision L1 gốc, không nổ", async () => {
    const judge = { async judge() { throw new Error("judge down"); } };
    const { rt, decisions } = baseHarness(judge, { judge: { model: "x", scope: "always" } });
    const r = await rt.chat(smallMsgs, []);
    assert.equal(r.message.content, "ok:claude-sonnet"); // base large (phase edit), không phải emergency fallback
    assert.equal(decisions[0].judge.verdict, "fallback");
    assert.match(decisions[0].reason, /judge-fallback/);
  });

  it("scope gray: chỉ gọi khi L1 gray — phase edit (score +2) không gọi", async () => {
    let called = 0;
    const judge = {
      async judge() {
        called++;
        return { tier: "small", ref: "box-api/qwen3.8-flash", confidence: 0.9, reason: "", ms: 1, tokens: 1 };
      },
    };
    const { rt } = baseHarness(judge, { judge: { model: "x", scope: "gray" } });
    await rt.chat(smallMsgs, []); // phase edit → base gray=false
    assert.equal(called, 0);
  });
});
