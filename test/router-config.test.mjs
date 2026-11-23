/**
 * P2.2 Phase B (plan/P2-02 §5, §4c) — rc `router` parse/validate, tier
 * resolution (explicit + auto-derive), startup `"model": "auto"`, runtime
 * branch (clientFactory short-circuits BEFORE the router) and turn sensors.
 * Chạy: npm run build && node --test test/router-config.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, parseRouter } from "../dist/config/config.js";
import { resolveRouterTiers } from "../dist/router/tiers.js";
import { parseProviderConfig } from "../dist/llm/provider-registry.js";
import { TurnSensors } from "../dist/router/sensors.js";
import { createClientRuntime } from "../dist/agent/provider-runtime.js";
import { RouterRuntime } from "../dist/router/router-runtime.js";

const TMP = join("/tmp", `scoder-router-cfg-${process.pid}`);
const GLOBAL_ISOLATION = join(TMP, "no-global-config.json");

function writeRc(obj) {
  writeFileSync(join(TMP, ".scoderrc.json"), JSON.stringify(obj), "utf8");
}

// provider block dùng chung mọi test — 1 small rẻ, 1 small đắt, 1 large.
const PROVIDERS = {
  provider: {
    "box-api": {
      options: { baseURL: "https://box.test/v1", apiKey: "sk-test" },
      models: {
        "tiny-fast": { cost: { input: 0.1, output: 0.3 }, limit: { context: 128000 } },
        "mid-code": { cost: { input: 0.5, output: 2 }, limit: { context: 200000 } },
        "big-heavy": { cost: { input: 3, output: 15 }, limit: { context: 1000000 } },
      },
    },
  },
};

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.SCODER_CONFIG = GLOBAL_ISOLATION;
  process.env.SCODER_TRUST_PROJECT = "1";
  delete process.env.SCODER_MODEL;
  delete process.env.SCODER_PROVIDER;
  delete process.env.SCODER_API_KEY;
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.SCODER_TRUST_PROJECT;
  if (process.env.SCODER_CONFIG === GLOBAL_ISOLATION) delete process.env.SCODER_CONFIG;
  delete process.env.SCODER_MODEL;
});

describe("parseRouter — validate kiểu parseLimits, rác → ignore + warn", () => {
  it("undefined / rác scalar → undefined", () => {
    assert.equal(parseRouter(undefined), undefined);
    assert.equal(parseRouter("yes"), undefined);
    assert.equal(parseRouter([]), undefined);
  });

  it("block hợp lệ giữ đúng từng field", () => {
    const c = parseRouter({
      enabled: true,
      fallback: "box-api/big-heavy",
      tiers: { small: ["box-api/tiny-fast"], large: ["box-api/big-heavy"] },
      rules: [{ when: "phase == edit", use: "small" }],
      signals: { smallMaxCtxTokens: 8000, largeToolSchemaChars: 999999 },
      escalate: { buildFails: 3 },
      judge: null,
    });
    assert.equal(c.enabled, true);
    assert.equal(c.fallback, "box-api/big-heavy");
    assert.deepEqual(c.tiers.small, ["box-api/tiny-fast"]);
    assert.deepEqual(c.rules, [{ when: "phase == edit", use: "small" }]);
    assert.equal(c.signals.smallMaxCtxTokens, 8000);
    assert.equal(c.escalate.buildFails, 3);
    assert.equal(c.judge, null);
  });

  it("rule rác / tier không phải string / signals âm → drop từng phần, không nổ", () => {
    const c = parseRouter({
      tiers: { small: ["ok/x", 42, "  "], large: "nope" },
      rules: [{ when: "phase == edit", use: "tiny" }, { when: "", use: "small" }],
      signals: { smallMaxCtxTokens: -5 },
    });
    assert.deepEqual(c.tiers.small, ["ok/x"]);
    assert.equal(c.tiers.large, undefined);
    assert.equal(c.rules, undefined);
    assert.equal(c.signals, undefined);
  });

  it("migration: classifier:true → judge gray + model rỗng (runtime tự chọn small rẻ nhất)", () => {
    const c = parseRouter({ classifier: true });
    assert.deepEqual(c.judge, { model: "", scope: "gray" });
  });

  it("judge object: scope/chặn minConfidence ngoài [0,1] → bỏ field đó, giữ model", () => {
    const c = parseRouter({ judge: { model: "box-api/tiny-fast", scope: "sometimes", minConfidence: 7 } });
    assert.deepEqual(c.judge, { model: "box-api/tiny-fast" });
  });
});

describe("resolveRouterTiers — refs → RouterModel qua luồng resolve P2.1", () => {
  const providers = parseProviderConfig(PROVIDERS.provider);

  it("explicit tiers: ref/tier/context/pricing/toolCall đủ; ref lạ → warning + drop", () => {
    const r = resolveRouterTiers({ tiers: { small: ["box-api/tiny-fast"], large: ["box-api/gpt-99"] } }, providers);
    assert.equal(r.models.length, 1);
    const m = r.models[0];
    assert.equal(m.ref, "box-api/tiny-fast");
    assert.equal(m.tier, "small");
    assert.equal(m.contextWindow, 128000);
    assert.deepEqual(m.pricing, { input: 0.1, output: 0.3 });
    assert.equal(m.toolCall, true);
    assert.match(r.warnings.join("\n"), /gpt-99/);
  });

  it("fallback mặc định = large context lớn nhất; router.fallback override; fallback ngoài tiers → warn + largest", () => {
    const ok = resolveRouterTiers({ tiers: { small: ["box-api/tiny-fast"], large: ["box-api/big-heavy", "box-api/mid-code"] } }, providers);
    assert.equal(ok.fallback.ref, "box-api/big-heavy"); // ctx 1M
    const want = resolveRouterTiers({ fallback: "mid-code", tiers: { small: ["box-api/tiny-fast"], large: ["box-api/big-heavy", "box-api/mid-code"] } }, providers);
    assert.equal(want.fallback.ref, "box-api/mid-code");
    const bad = resolveRouterTiers({ fallback: "box-api/nope", tiers: { small: ["box-api/tiny-fast"] } }, providers);
    assert.match(bad.warnings.join("\n"), /fallback/);
    assert.equal(bad.fallback.ref, "box-api/tiny-fast");
  });

  it("thiếu router.tiers → auto-derive theo cost.output: nửa rẻ small, nửa đắt large", () => {
    const r = resolveRouterTiers({}, providers);
    assert.equal(r.models.length, 3);
    assert.equal(r.models.find((m) => m.model === "tiny-fast").tier, "small");
    assert.equal(r.models.find((m) => m.model === "mid-code").tier, "small"); // ceil(3/2)=2
    assert.equal(r.models.find((m) => m.model === "big-heavy").tier, "large");
    assert.match(r.warnings.join("\n"), /auto-derived/);
  });

  it("1 model có giá / 0 model → không derive, warning nói cách bật", () => {
    const one = resolveRouterTiers({}, parseProviderConfig({ "box-api": { options: { baseURL: "https://x/v1" }, models: { a: { cost: { input: 0.5, output: 1 } } } } }));
    assert.equal(one.models.length, 0);
    assert.match(one.warnings.join("\n"), /router.tiers/);
    const none = resolveRouterTiers({}, parseProviderConfig({ "box-api": { options: { baseURL: "https://x/v1" }, models: { a: {} } } }));
    assert.equal(none.fallback, null);
  });

  it("ref trùng 2 tiers → giữ lần liệt kê ĐẦU; bare id unique → chuẩn hoá provider/id", () => {
    const r = resolveRouterTiers({ tiers: { small: ["box-api/mid-code"], large: ["mid-code", "box-api/big-heavy"] } }, providers);
    assert.deepEqual(r.models.map((m) => `${m.ref}:${m.tier}`), ["box-api/mid-code:small", "box-api/big-heavy:large"]);
  });
});

describe("loadConfig — startup mode (§4c: bật là config, bật routing mới là auto)", () => {
  it('"model": "auto" + enabled + tiers → mode auto, model = ref fallback', () => {
    writeRc({ ...PROVIDERS, model: "auto", router: { enabled: true, tiers: { small: ["box-api/tiny-fast"], large: ["box-api/big-heavy"] } } });
    const cfg = loadConfig({ workdir: TMP });
    assert.equal(cfg.routerMode, "auto");
    assert.equal(cfg.model, "big-heavy");
    assert.equal(cfg.providerDef?.id, "box-api");
    assert.equal(cfg.router.enabled, true);
  });

  it('"model": "auto"` nhưng router thiếu → warn + model mặc định provider, KHÔNG có model "auto"', () => {
    writeRc({ model: "auto" });
    const cfg = loadConfig({ workdir: TMP });
    assert.notEqual(cfg.model, "auto");
    assert.equal(cfg.routerMode, undefined);
  });

  it("router.enabled + model cụ thể → pinned (router dựng nhưng im lặng đến khi /model auto)", () => {
    writeRc({ ...PROVIDERS, model: "box-api/mid-code", router: { enabled: true, tiers: { small: ["box-api/tiny-fast"], large: ["box-api/big-heavy"] } } });
    const cfg = loadConfig({ workdir: TMP });
    assert.equal(cfg.routerMode, "pinned");
    assert.equal(cfg.model, "mid-code");
  });

  it("router rác → config.router đã sanitize; runtime branch chỉ bật khi enabled:true", () => {
    writeRc({ ...PROVIDERS, model: "box-api/mid-code", router: "banana" });
    const cfg = loadConfig({ workdir: TMP });
    assert.equal(cfg.router, undefined);
  });

  it("không có router → cfg.router undefined: byte-identical path cũ", () => {
    writeRc({ ...PROVIDERS, model: "box-api/mid-code" });
    const cfg = loadConfig({ workdir: TMP });
    assert.equal(cfg.router, undefined);
    assert.equal(cfg.routerMode, undefined);
  });
});

describe("createClientRuntime — branch router (plan §1)", () => {
  const base = () => {
    writeRc({ ...PROVIDERS, model: "auto", router: { enabled: true, tiers: { small: ["box-api/tiny-fast"], large: ["box-api/big-heavy"] } } });
    return { ...loadConfig({ workdir: TMP }), apiKey: "sk-test", workdir: TMP };
  };

  it("router.enabled → RouterRuntime; startup auto = mode auto, tiers khớp rc", () => {
    const cfg = base();
    const rt = createClientRuntime(cfg);
    assert.ok(rt instanceof RouterRuntime);
    assert.equal(rt.routerMode, "auto");
    assert.equal(rt.activeRef, "box-api/big-heavy");
    assert.deepEqual(rt.candidates.map((m) => m.tier), ["small", "large"]);
  });

  it("router.enabled + model cụ thể → RouterRuntime ở mode PINNED, active = model đã pin", () => {
    const cfg = base();
    cfg.routerMode = "pinned";
    cfg.model = "tiny-fast";
    cfg.providerDef = parseProviderConfig(PROVIDERS.provider)["box-api"];
    const rt = createClientRuntime(cfg);
    assert.ok(rt instanceof RouterRuntime);
    assert.equal(rt.routerMode, "pinned");
    assert.equal(rt.activeRef, "box-api/tiny-fast");
  });

  it("clientFactory thắng TRƯỚC router — eval transcripts không đổi (I-12)", () => {
    const cfg = base();
    const fake = { model: "fake", lastPartialToolCalls: [], setModel() {} };
    cfg.clientFactory = () => fake;
    assert.equal(createClientRuntime(cfg), fake);
  });

  it("router.enabled nhưng tiers resolve rỗng → null → runtime thường, run không chết", () => {
    const cfg = base();
    cfg.router = { enabled: true, tiers: { small: ["nope/x"], large: ["nope/y"] } };
    const rt = createClientRuntime(cfg);
    assert.ok(!(rt instanceof RouterRuntime));
    assert.equal(rt.model, cfg.model);
  });
});

describe("TurnSensors — suy tín hiệu từ event stream (plan §2)", () => {
  const mk = () => new TurnSensors();

  it("step/tool_call/build/guardrail/tool_result map đúng field", () => {
    const s = mk();
    s.track({ type: "run_start" });
    s.track({ type: "step", step: 4, maxSteps: 40 });
    s.track({ type: "tool_call", name: "edit_file" });
    assert.equal(s.context().step, 4);
    assert.equal(s.context().maxSteps, 40);
    assert.equal(s.context().phase, "edit");
    s.track({ type: "build", success: false });
    s.track({ type: "build", success: false });
    assert.equal(s.context().buildFailStreak, 2);
    s.track({ type: "build", success: true });
    assert.equal(s.context().buildFailStreak, 0);
    s.track({ type: "guardrail" });
    assert.equal(s.context().guardrailStreak, 1);
    s.track({ type: "tool_result", ok: false, output: "ERROR: invalid JSON arguments: {" });
    assert.equal(s.context().toolArgsRepairStreak, 1);
    s.track({ type: "tool_result", ok: true });
    assert.equal(s.context().toolArgsRepairStreak, 0);
    assert.equal(s.context().guardrailStreak, 0);
  });

  it("run_start / reset() xóa sạch streak giữa 2 run", () => {
    const s = mk();
    s.track({ type: "build", success: false });
    s.track({ type: "build", success: false });
    s.track({ type: "run_start" });
    assert.equal(s.context().buildFailStreak, 0);
    s.track({ type: "build", success: false });
    s.reset(10);
    assert.equal(s.context().buildFailStreak, 0);
    assert.equal(s.context().maxSteps, 10);
  });

  it("guardrail streak decay khi có ≥5 step sạch xen giữa; context() là bản copy", () => {
    const s = mk();
    s.track({ type: "step", step: 1, maxSteps: 40 });
    s.track({ type: "guardrail" });
    for (const st of [2, 3, 4, 5, 6]) s.track({ type: "step", step: st, maxSteps: 40 });
    assert.equal(s.context().guardrailStreak, 0);
    const c = s.context();
    c.step = 99;
    assert.equal(s.context().step, 6);
  });

  it("event lạ / thiếu field → ignore, không NaN", () => {
    const s = mk();
    s.track({ type: "totally_unknown" });
    s.track({ type: "step" });
    s.track({ type: "tool_call" });
    assert.equal(s.context().step, 0);
  });
});
