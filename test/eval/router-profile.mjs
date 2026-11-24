/**
 * P2.2 Phase E eval gate — 4 config routing trên cùng một transcript:
 *   1. PINNED large   (đường cơ sở: mọi turn vào model mạnh nhất)
 *   2. PINNED small   (đường cơ sở giá rẻ)
 *   3. Router 3-layer (L1+L2+L3, judge=null — mặc định production)
 *   4. Router 4-layer (judge accept một target rẻ hơn trong band xám)
 *
 * "Pass" ở mock-level = mô hình được chọn đúng theo tín hiệu (turn ngắn →
 * small, turn nặng → large, build-fail escalation vẫn large) — không phải
 * quality thật (cần API key, xem plan §AC). Mỗi lần chạy ghi số liệu vào
 * plan/baseline/router-eval.json để so sánh giữa các phiên bản router.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RouterRuntime } from "../../dist/router/router-runtime.js";
import { createJudge } from "../../dist/router/judge.js";

const MODELS = [
  { ref: "box-api/mini", tier: "small", model: "mini", provider: "box-api", toolCall: true, contextWindow: 128000, pricing: { input: 0.2, output: 0.8 } },
  { ref: "box-api/pro", tier: "large", model: "pro", provider: "box-api", toolCall: true, contextWindow: 262000, pricing: { input: 3, output: 15 } },
];

/** Fake per-model client — đếm số lượt mỗi model thực nhận. */
function makeHarness(judgeCfg) {
  const counts = { "box-api/mini": 0, "box-api/pro": 0 };
  const decisions = [];
  let turn = 0;
  const rt = new RouterRuntime({
    models: MODELS,
    fallbackRef: "box-api/mini",
    config: {
      signals: { smallMaxCtxTokens: 16000, largeToolSchemaChars: 30000 },
      rules: [],
      escalate: { buildFails: 2, stickyMinSteps: 2 },
      ...(judgeCfg ? { judge: judgeCfg } : {}),
    },
    makeClient: (m) => {
      return {
        model: m.model,
        lastPartialToolCalls: [],
        setModel() {},
        async chat() {
          counts[m.ref]++;
          return { message: { role: "assistant", content: "done", stop_reason: "stop" }, usage: { prompt_tokens: 50, completion_tokens: 10 } };
        },
        async *streamChat() {
          counts[m.ref]++;
          yield { contentDelta: "done" };
        },
      };
    },
    onRoute: (d) => decisions.push(d),
    mode: "auto",
    sensors: () => ({ step: ++turn, maxSteps: 0, phase: null, buildFailStreak: 0, guardrailStreak: 0, toolArgsRepairStreak: 0 }),
    ...(judgeCfg ? { judge: createJudge({ client: judgeClient(), model: "box-api/mini", timeoutMs: 1500 }) } : {}),
  });
  return { rt, counts, decisions };
}

let judgeCalls = 0;
function judgeClient() {
  return {
    async chat() {
      judgeCalls++;
      return { message: { content: '{"ref":"box-api/mini","tier":"small","confidence":0.8,"reason":"sửa 1 dòng"}' }, usage: { prompt_tokens: 400, completion_tokens: 30 } };
    },
  };
}

const shortTurn = [{ role: "user", content: "đổi tên biến x thành y" }];
const heavyTurn = [
  { role: "user", content: `refactor module edges ${"code ".repeat(13000)}` },
  { role: "assistant", content: `analysis ${"detail ".repeat(7000)}` },
];

async function drive(rt, ctxSeed) {
  let ctx = ctxSeed ?? 1;
  await rt.chat(shortTurn, []);
  await rt.chat(heavyTurn, []);
  ctx += 1;
  await rt.chat(heavyTurn, []);
  await rt.chat(heavyTurn, []);
  return ctx;
}

async function profile() {
  const out = { ts: new Date().toISOString(), configs: {} };

  // 1) pinned large — baseline quality proxy: mọi turn vào pro.
  const pinned = makeHarness(null);
  pinned.rt.setModel("box-api/pro");
  await drive(pinned.rt);
  out.configs.pinned_large = { calls: { ...pinned.counts }, decisions: pinned.decisions.length };
  if (pinned.counts["box-api/pro"] !== 4 || pinned.counts["box-api/mini"] !== 0) {
    throw new Error(`pinned large: expected 4 pro calls, got ${JSON.stringify(pinned.counts)}`);
  }

  // 2) pinned small — baseline cost proxy.
  const pinnedSmall = makeHarness(null);
  pinnedSmall.rt.setModel("box-api/mini");
  await drive(pinnedSmall.rt);
  out.configs.pinned_small = { calls: { ...pinnedSmall.counts } };
  if (pinnedSmall.counts["box-api/mini"] !== 4) throw new Error("pinned small must route every turn to mini");

  // 3) 3-layer router — turn nặng phải lên large, turn nhẹ ở small.
  const three = makeHarness(null);
  await drive(three.rt);
  const threeTiers = three.decisions.map((d) => d.tier);
  out.configs.router_3layer = { calls: { ...three.counts }, tiers: threeTiers, decisions: three.decisions.length };
  if (three.decisions.length !== 4) throw new Error("auto mode must emit one decision per turn");
  if (!threeTiers.includes("large")) throw new Error("3-layer router never escalated the heavy turns");

  // 4) 4-layer judge — cùng transcript, judge chỉ hỏi khi có cấu hình.
  judgeCalls = 0;
  const four = makeHarness({ model: "box-api/mini", scope: "always", minConfidence: 0.6 });
  await drive(four.rt);
  out.configs.router_4layer_judge = {
    calls: { ...four.counts },
    decisions: four.decisions.length,
    judgeCalls,
    judged: four.decisions.filter((d) => d.judge).map((d) => d.judge.verdict),
  };
  if (judgeCalls === 0) throw new Error("judge config ran zero judge calls");
  const judged = four.decisions.filter((d) => d.judge);
  if (judged.length !== four.decisions.length) throw new Error("scope=always must judge every decision");
  if (judged.some((d) => d.judge.verdict !== "accept")) throw new Error("clean judge transcript should accept");
  // Judge chấp small cho band xám → không được ĐÔNG hơn 3-layer ở large (target rẻ thắng).
  const fourLarge = four.decisions.filter((d) => d.tier === "large").length;
  const threeLarge = threeTiers.filter((t) => t === "large").length;
  if (fourLarge > threeLarge) throw new Error("judge must not escalate beyond the 3-layer pipeline on this transcript");

  return out;
}

export default {
  name: "router decision profile (4-config eval gate)",
  async run() {
    const data = await profile();
    const dir = join(process.cwd(), "plan", "baseline");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "router-eval.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
    const notes = `pinned_large=${JSON.stringify(data.configs.pinned_large.calls)} · 3layer=${JSON.stringify(data.configs.router_3layer.calls)} · judge=${JSON.stringify(data.configs.router_4layer_judge.calls)} judgeCalls=${data.configs.router_4layer_judge.judgeCalls} → plan/baseline/router-eval.json`;
    return { ok: true, notes };
  },
  check() {
    /* self-contained qua run() */
  },
};
