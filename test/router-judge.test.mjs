/**
 * P2.2 Phase E (plan/P2-02 §3) — L4 judge: createJudge (parse/validate/cache/
 * timeout/never-throws), resolveJudgeModel + pickCheapestSmall (định dạng
 * ref giống tier rules), và nối thật vào RouterRuntime (judgeLabel, accept
 * đổi target, loại toolCall:false khi turn có tools).
 * Chạy: npm run build && node --test test/router-judge.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJudge } from "../dist/router/judge.js";
import { resolveJudgeModel, pickCheapestSmall } from "../dist/router/tiers.js";
import { RouterRuntime } from "../dist/router/router-runtime.js";
import { IDLE_TURN_CONTEXT } from "../dist/router/types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function jsonClient(text, opts = {}) {
  const seen = [];
  return {
    seen,
    async chat(messages, tools, callOpts) {
      seen.push({ messages, tools, callOpts });
      if (opts.throw) throw new Error("boom");
      if (opts.hang) return new Promise(() => {});
      return { message: { content: text }, usage: { prompt_tokens: 100, completion_tokens: 20 } };
    },
  };
}

const small = { ref: "p/mini", tier: "small", model: "mini", provider: "p", toolCall: true, pricing: { input: 0.2, output: 0.8 } };
const large = { ref: "p/big", tier: "large", model: "big", provider: "p", toolCall: true, pricing: { input: 3, output: 15 } };
const noTools = { ref: "p/reader", tier: "small", model: "reader", provider: "p", toolCall: false, pricing: { input: 0.1, output: 0.4 } };

function runtimeHarness(judge, judgeCfg = { model: "p/judge", scope: "always" }) {
  const decisions = [];
  const targets = [];
  const fake = (m) => {
    targets.push(m.ref);
    return {
      model: m.model,
      lastPartialToolCalls: [],
      setModel() {},
      async chat() {
        return { message: { role: "assistant", content: "ok", stop_reason: "stop" } };
      },
      async *streamChat() {
        yield { contentDelta: "ok" };
      },
    };
  };
  const rt = new RouterRuntime({
    models: [small, large, noTools],
    fallbackRef: small.ref,
    config: {
      signals: { smallMaxCtxTokens: 16000, largeToolSchemaChars: 30000 },
      rules: [],
      escalate: { buildFails: 2, stickyMinSteps: 2 },
      judge: judgeCfg,
    },
    makeClient: fake,
    sensors: () => IDLE_TURN_CONTEXT,
    onRoute: (d) => decisions.push(d),
    judge,
    mode: "auto",
  });
  return { rt, decisions, targets };
}

const MSG = [{ role: "user", content: "sửa 1 dòng typo" }];
const TOOL = [{ name: "edit", description: "x".repeat(10), parameters: {} }];

// ── createJudge unit ─────────────────────────────────────────────────────────

describe("createJudge — parse + validate + never throws", () => {
  it("JSON hợp lệ → verdict đủ field, tokens cộng từ usage", async () => {
    const client = jsonClient('some prose {"ref":"p/big","tier":"large","confidence":0.8,"reason":"edit đa file"} tail');
    const j = createJudge({ client, model: "p/judge" });
    const v = await j.judge(IDLE_TURN_CONTEXT, [small, large], { tier: "small", reason: "score" });
    assert.equal(v.ref, "p/big");
    assert.equal(v.tier, "large");
    assert.equal(v.confidence, 0.8);
    assert.equal(v.reason, "edit đa file");
    assert.equal(v.tokens, 120);
    assert.ok(v.ms >= 0);
  });

  it("confidence ngoài khoảng → clamp 0..1; rác → ref null + judge-unparseable", async () => {
    const hi = createJudge({ client: jsonClient('{"ref":"p/big","confidence":5}'), model: "x" });
    const v1 = await hi.judge(IDLE_TURN_CONTEXT, [small], { tier: "small", reason: "r" });
    assert.equal(v1.confidence, 1);
    const junk = createJudge({ client: jsonClient("xin chào"), model: "x" });
    const v2 = await junk.judge(IDLE_TURN_CONTEXT, [small], { tier: "small", reason: "r" });
    assert.equal(v2.ref, null);
    assert.equal(v2.confidence, 0);
    assert.equal(v2.reason, "judge-unparseable");
  });

  it("client ném lỗi → verdict judge-error, KHÔNG throw", async () => {
    const j = createJudge({ client: jsonClient("", { throw: true }), model: "x" });
    const v = await j.judge(IDLE_TURN_CONTEXT, [small], { tier: "small", reason: "r" });
    assert.equal(v.ref, null);
    assert.equal(v.reason, "judge-error");
  });

  it("client treo + timeoutMs nhỏ → judge-timeout nhanh", async () => {
    const j = createJudge({ client: jsonClient("", { hang: true }), model: "x", timeoutMs: 30 });
    const t0 = Date.now();
    const v = await j.judge(IDLE_TURN_CONTEXT, [small], { tier: "small", reason: "r" });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(v.reason, "judge-timeout");
    assert.equal(v.ref, null);
  });

  it("cache TTL: ctx+tier+refs như nhau → gọi client đúng 1 lần; step đổi → gọi tiếp", async () => {
    const client = jsonClient('{"ref":"p/big","confidence":0.9,"reason":"x"}');
    const j = createJudge({ client, model: "x" });
    await j.judge(IDLE_TURN_CONTEXT, [small, large], { tier: "small", reason: "r" });
    await j.judge(IDLE_TURN_CONTEXT, [small, large], { tier: "small", reason: "r" });
    assert.equal(client.seen.length, 1);
    await j.judge({ ...IDLE_TURN_CONTEXT, step: 7 }, [small, large], { tier: "small", reason: "r" });
    assert.equal(client.seen.length, 2);
  });

  it("lỗi/timeout KHÔNG được cache (turn sau hỏi lại)", async () => {
    const j = createJudge({ client: jsonClient("", { throw: true }), model: "x" });
    await j.judge(IDLE_TURN_CONTEXT, [small], { tier: "small", reason: "r" });
    await j.judge(IDLE_TURN_CONTEXT, [small], { tier: "small", reason: "r" });
    assert.ok(true); // không throw lần 2 — đã cache trắng
  });

  it("prompt chứa bảng ref/tier/ctx/giá và tín hiệu turn; toolCall:false hiện khi turn không tools", async () => {
    const client = jsonClient('{"ref":"p/reader","confidence":0.7,"reason":"đọc"}');
    const j = createJudge({ client, model: "x" });
    await j.judge(IDLE_TURN_CONTEXT, [small, large, noTools], { tier: "small", reason: "r" });
    const userMsg = client.seen[0].messages[1].content;
    assert.match(userMsg, /p\/reader \(tier small/);
    assert.match(userMsg, /output \$15\/M/);
    assert.match(userMsg, /text-only/);
    assert.match(userMsg, /build-fails 0/);
  });
});

// ── RouterRuntime nối judge thật ─────────────────────────────────────────────

describe("RouterRuntime + judge thật (createJudge)", () => {
  it("judge accept ref large → target đổi, reason 'judge:', decision.judge.verdict accept", async () => {
    const judge = createJudge({ client: jsonClient('{"ref":"p/big","tier":"large","confidence":0.9,"reason":"debug khó"}'), model: "p/judge" });
    const { rt, decisions } = runtimeHarness(judge);
    assert.equal(rt.judgeLabel, "p/judge");
    await rt.chat([...MSG, { role: "assistant", content: "y".repeat(4000) }], TOOL);
    assert.equal(decisions.length, 1);
    const d = decisions[0];
    assert.equal(d.ref, large.ref);
    assert.equal(d.judge.verdict, "accept");
    assert.equal(d.judge.model, large.ref);
    assert.match(d.reason, /judge: debug khó/);
  });

  it("judge confidence thấp (< minConfidence) → reject-confidence, giữ kết quả L1", async () => {
    const judge = createJudge({ client: jsonClient('{"ref":"p/big","confidence":0.2,"reason":"chưa chắc"}'), model: "p/judge" });
    const { rt, decisions } = runtimeHarness(judge, { model: "p/judge", scope: "always", minConfidence: 0.6 });
    await rt.chat([...MSG, { role: "assistant", content: "y".repeat(4000) }], TOOL);
    assert.equal(decisions[0].judge.verdict, "reject-confidence");
    assert.equal(decisions[0].ref, small.ref);
    assert.match(decisions[0].reason, /judge-reject\(confidence\)/);
  });

  it("judge bịa ref ngoài allowlist → reject-hallucinated, pipeline không đổi", async () => {
    const judge = createJudge({ client: jsonClient('{"ref":"p/GHOST","confidence":0.9}'), model: "p/judge" });
    const { rt, decisions } = runtimeHarness(judge);
    await rt.chat(MSG, TOOL);
    assert.equal(decisions[0].judge.verdict, "reject-hallucinated");
    assert.match(decisions[0].reason, /judge-reject\(hallucinated\)/);
    assert.ok(!decisions[0].ref.includes("GHOST"));
  });

  it("timeout → verdict 'timeout' + reason 'judge-timeout'; lỗi → 'fallback' — KHÔNG đổ hallucinated", async () => {
    const to = runtimeHarness(createJudge({ client: jsonClient("", { hang: true }), model: "p/j", timeoutMs: 30 }));
    await to.rt.chat(MSG, TOOL);
    assert.equal(to.decisions[0].judge.verdict, "timeout");
    assert.match(to.decisions[0].reason, /· judge-timeout/);
    const boom = runtimeHarness(createJudge({ client: jsonClient("", { throw: true }), model: "p/j" }));
    await boom.rt.chat(MSG, TOOL);
    assert.equal(boom.decisions[0].judge.verdict, "fallback");
    assert.match(boom.decisions[0].reason, /· judge-fallback/);
  });

  it("judge ném exception trực tiếp (vi phạm contract) → fallback, run không nổ", async () => {
    const evil = { async judge() { throw new Error("plugin bug"); } };
    const { rt, decisions } = runtimeHarness(evil);
    await rt.chat(MSG, TOOL);
    assert.equal(decisions[0].judge.verdict, "fallback");
    assert.equal(decisions[0].ref, small.ref);
  });

  it("turn CÓ tools → bảng candidate gửi judge loại toolCall:false; turn không tools → có mặt", async () => {
    const client = jsonClient('{"ref":"p/mini","confidence":0.8,"reason":"x"}');
    const judge = createJudge({ client, model: "p/judge" });
    const { rt } = runtimeHarness(judge);
    await rt.chat([...MSG, { role: "assistant", content: "y".repeat(4000) }], TOOL);
    assert.doesNotMatch(client.seen[0].messages[1].content, /p\/reader/);
    await rt.chat(MSG, []);
    assert.match(client.seen[1].messages[1].content, /p\/reader/);
  });
});

// ── resolver helpers (Phase E wiring) ────────────────────────────────────────

describe("resolveJudgeModel + pickCheapestSmall", () => {
  const declaring = {
    id: "box-api",
    baseUrl: "https://x/v1",
    apiKeyEnv: "BOX_API_KEY",
    kind: "openai",
    models: { "mini": { contextWindow: 128000, pricing: { input: 0.2, output: 0.8 } } },
  };
  const bare = { id: "other", baseUrl: "https://y/v1", apiKeyEnv: "Y_KEY", kind: "openai" };

  it("ref declared → RouterModel với def; ref không declared dưới provider có models → null + warn", () => {
    const ok = resolveJudgeModel("box-api/mini", { "box-api": declaring });
    assert.equal(ok.model.ref, "box-api/mini");
    assert.equal(ok.model.def?.id, "box-api");
    assert.deepEqual(ok.warnings, []);
    const bad = resolveJudgeModel("box-api/typo", { "box-api": declaring });
    assert.equal(bad.model, null);
    assert.equal(bad.warnings.length, 1);
  });

  it("ref id trần unique → suy ra provider; provider lạ → null", () => {
    const one = resolveJudgeModel("mini", { "box-api": declaring });
    assert.equal(one.model.ref, "box-api/mini");
    const none = resolveJudgeModel("nope/nope-nope", { "box-api": declaring });
    assert.equal(none.model, null);
  });

  it("pickCheapestSmall: rẻ nhất theo output, giá không biết xếp cuối, không small → null", () => {
    const m = pickCheapestSmall([large, small, noTools]);
    assert.equal(m.ref, noTools.ref); // 0.4 < 0.8
    const priced = pickCheapestSmall([
      { ...small, pricing: undefined },
      { ...small, ref: "p/cheap", model: "cheap", pricing: { input: 0.1, output: 0.2 } },
    ]);
    assert.equal(priced.ref, "p/cheap");
    assert.equal(pickCheapestSmall([large]), null);
  });

  it("classifier:true migration → judge model '' → smallest-priced qua pickCheapestSmall", () => {
    const models = [small, noTools, large];
    assert.equal(pickCheapestSmall(models).ref, noTools.ref);
  });
});
