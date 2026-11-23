/**
 * P2.2 Phase A (plan/P2-02 §4c) — chế độ PINNED ↔ AUTO của RouterRuntime:
 * pin = im lặng tuyệt đối (0 decision), auto = pipeline per-lượt, toggle
 * 2 chiều ngay trong session, không restart.
 * Chạy: npm run build && node --test test/router-mode.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouterRuntime } from "../dist/router/router-runtime.js";
import { IDLE_TURN_CONTEXT } from "../dist/router/types.js";

function fake(model) {
  return {
    model,
    lastPartialToolCalls: [],
    setModel(m) {
      this.model = m;
    },
    async chat() {
      return { message: { role: "assistant", content: `ok:${model}`, stop_reason: "stop" } };
    },
    async *streamChat() {
      yield { contentDelta: model };
    },
  };
}

const MODELS = [
  { ref: "box-api/kimi-k3", tier: "large", model: "kimi-k3", provider: "box-api", toolCall: true, contextWindow: 200000 },
  { ref: "box-api/qwen3.8-flash", tier: "small", model: "qwen3.8-flash", provider: "box-api", toolCall: true, pricing: { input: 0.2, output: 0.8 } },
];
const CFG = { signals: { smallMaxCtxTokens: 16000, largeToolSchemaChars: 30000 }, rules: [], escalate: { buildFails: 2, stickyMinSteps: 2 } };

function make(over = {}) {
  const decisions = [];
  const rt = new RouterRuntime({
    models: structuredClone(MODELS),
    fallbackRef: "box-api/kimi-k3",
    config: CFG,
    makeClient: (m) => fake(m.model),
    sensors: () => ({ ...IDLE_TURN_CONTEXT, phase: "edit", step: 4 }), // base luôn large
    onRoute: (d) => decisions.push(d),
    ...over,
  });
  return { rt, decisions };
}

const BIG = [{ role: "user", content: "y".repeat(200000) }]; // đủ to để auto chọn large nếu có tools nhỏ

describe("PINNED (mặc định startup)", () => {
  it("pinned = ref fallback, chat đi đúng model, 0 route_decision emit", async () => {
    const { rt, decisions } = make();
    assert.equal(rt.routerMode, "pinned");
    assert.equal(rt.activeRef, "box-api/kimi-k3");
    const r = await rt.chat(BIG, []);
    assert.equal(r.message.content, "ok:kimi-k3");
    assert.equal(decisions.length, 0); // router idle — con người thắng
    await rt.chat(BIG, [{ type: "function", function: { name: "t", description: "d".repeat(40000), parameters: {} } }]);
    assert.equal(decisions.length, 0);
  });

  it("pinnedRef không tồn tại trong tiers → tự về fallback (không nổ)", () => {
    const { rt } = make({ pinnedRef: "box-api/kimi-k99" });
    assert.equal(rt.activeRef, "box-api/kimi-k3");
  });

  it("/model <ref> → pin ngay trong session; /model <bare unique> cũng vậy", async () => {
    const { rt, decisions } = make();
    rt.setModel("box-api/qwen3.8-flash");
    assert.equal(rt.routerMode, "pinned");
    await rt.chat(BIG, []);
    assert.equal(decisions.length, 0);
    assert.equal(rt.activeRef, "box-api/qwen3.8-flash");
    rt.setModel("kimi-k3"); // bare id unique
    assert.equal(rt.activeRef, "box-api/kimi-k3");
  });

  it("/model <id ngoài tiers> → pin model ngoại lai trên provider fallback", async () => {
    const { rt } = make();
    rt.setModel("gpt-4o-mini");
    assert.equal(rt.routerMode, "pinned");
    assert.equal(rt.activeRef, "box-api/gpt-4o-mini");
    const r = await rt.chat(BIG, []);
    assert.equal(r.message.content, "ok:gpt-4o-mini");
  });
});

describe("AUTO (`/model auto`, `\"model\": \"auto\"`)", () => {
  it("auto → pipeline chạy per-lượt, emit decision; toggle 2 chiều không restart", async () => {
    const { rt, decisions } = make();
    rt.setModel("auto");
    assert.equal(rt.routerMode, "auto");
    await rt.chat(BIG, []);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].tier, "large"); // phase edit + ctx lớn
    assert.equal(decisions[0].ref, "box-api/kimi-k3");
    await rt.chat(BIG, []);
    assert.equal(decisions.length, 2); // mọi lượt auto đều emit
    rt.setModel("box-api/kimi-k3"); // quay lại PINNED
    await rt.chat(BIG, []);
    assert.equal(decisions.length, 2); // pin: im lặng trở lại
  });

  it("lastRouteDecision expose decision mới nhất cho UI/`/model`", async () => {
    const { rt } = make();
    assert.equal(rt.lastRouteDecision, null);
    rt.setModel("auto");
    await rt.chat([{ role: "user", content: "nhỏ" }], []);
    assert.equal(rt.lastRouteDecision?.tier, "large"); // phase edit vẫn large — sensors
    assert.equal(rt.lastRouteDecision?.switched, true);
  });

  it("candidates readonly — pin ngoại lai thêm model nhưng tiers gốc không mất", async () => {
    const { rt } = make();
    const before = rt.candidates.length;
    rt.setModel("stranger");
    assert.equal(rt.candidates.length, before + 1);
    assert.deepEqual(rt.candidates.slice(0, before).map((m) => m.ref), MODELS.map((m) => m.ref));
  });
});

describe("construct validation (Phase B dựa vào đây để tắt router an toàn)", () => {
  it("tiers rỗng / fallback không nằm trong tiers → throw (caller phải catch & warn)", () => {
    assert.throws(
      () => new RouterRuntime({ models: [], fallbackRef: "x/y", config: CFG, makeClient: fake }),
      /no tier models/,
    );
    assert.throws(
      () => new RouterRuntime({ models: structuredClone(MODELS), fallbackRef: "nope", config: CFG, makeClient: fake }),
      /fallback/,
    );
  });
});

describe("setTiers — hot-reload rc router.tiers giữa session (plan §B/hot-reload)", () => {
  it("tier mới thay candidate list, decision lượt kế chạy theo tiers mới", async () => {
    const { rt, decisions } = make({ mode: "auto" });
    await rt.chat([{ role: "user", content: "hi" }], []); // phase edit (sensors) → large kimi-k3
    assert.equal(decisions[0].ref, "box-api/kimi-k3");
    // Sửa rc: bỏ kimi-k3, fallback chuyển sang qwen.
    const next = structuredClone(MODELS).filter((m) => m.ref !== "box-api/kimi-k3");
    assert.equal(rt.setTiers(next, "box-api/qwen3.8-flash"), true);
    await rt.chat([{ role: "user", content: "hi" }], []);
    assert.equal(decisions[1].ref, "box-api/qwen3.8-flash"); // tier mới thắng, không còn ref cũ
  });

  it("setTiers input hỏng (rỗng / fallback không có) → false, giữ nguyên tiers cũ", () => {
    const { rt } = make();
    assert.equal(rt.setTiers([], "x/y"), false);
    assert.equal(rt.setTiers(structuredClone(MODELS), "ghost/model"), false);
    assert.equal(rt.candidates.length, MODELS.length);
  });

  it("pin một ref sắp bị xoá → setTiers trả pin về fallback (không treo ref lạ)", () => {
    const { rt } = make();
    rt.setModel("box-api/qwen3.8-flash");
    const next = structuredClone(MODELS).filter((m) => m.ref !== "box-api/qwen3.8-flash");
    assert.equal(rt.setTiers(next, "box-api/kimi-k3"), true);
    assert.equal(rt.activeRef, "box-api/kimi-k3");
  });
});
