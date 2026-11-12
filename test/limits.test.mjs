/**
 * G7: rc "limits" — parse + validate + defaults.
 * P0-2/P0-3/P1-2/P2: các khoá mới (toolOutputChars, mcpSchemaTokens,
 * buildTimeoutSecs, mcpTools, verifyCache, localProfile, contextWindow).
 * Chạy: node --test test/limits.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  LIMIT_DEFAULTS,
  LOCAL_PROFILE_DEFAULTS,
  resolveLimits,
  isLocalBaseUrl,
  applyLocalProfile,
} from "../dist/config/config.js";

let dir;
let prevConfigPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limits-"));
  // rc TOÀN CỤC (~/.scoder/config.json) của máy dev có thể chứa "limits" →
  // test sẽ phụ thuộc môi trường. trỏ SCODER_CONFIG vào file không tồn tại.
  prevConfigPath = process.env.SCODER_CONFIG;
  process.env.SCODER_CONFIG = join(dir, "no-global-config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevConfigPath === undefined) delete process.env.SCODER_CONFIG;
  else process.env.SCODER_CONFIG = prevConfigPath;
});

const base = { apiKey: "k", baseUrl: "http://x", model: "m", provider: "openai" };

describe("parseLimits (G7)", () => {
  it("không có limits → AgentConfig.limits undefined", () => {
    const cfg = loadConfig({ workdir: dir, ...base });
    assert.equal(cfg.limits, undefined);
  });

  it("rc limits hợp lệ → parse đủ 4 field", () => {
    writeFileSync(join(dir, ".scoderrc.json"), JSON.stringify({
      limits: { requestTimeoutMs: 30000, maxOutputChars: 5000, toolConcurrency: 2, renderCap: 100 },
    }));
    const cfg = loadConfig({ workdir: dir, ...base });
    assert.deepEqual(cfg.limits, { requestTimeoutMs: 30000, maxOutputChars: 5000, toolConcurrency: 2, renderCap: 100 });
  });

  it("giá trị sai (0, âm, string, NaN) → bỏ qua field đó", () => {
    writeFileSync(join(dir, ".scoderrc.json"), JSON.stringify({
      limits: { requestTimeoutMs: -5, maxOutputChars: "big", toolConcurrency: 0, renderCap: 150 },
    }));
    const cfg = loadConfig({ workdir: dir, ...base });
    assert.deepEqual(cfg.limits, { renderCap: 150 });
  });

  it("resolveLimits: defaults + override một phần", () => {
    assert.deepEqual(resolveLimits(undefined), LIMIT_DEFAULTS);
    assert.deepEqual(resolveLimits({ toolConcurrency: 8 }), { ...LIMIT_DEFAULTS, toolConcurrency: 8 });
  });

  it("P0-2/P1-2: keys mới có default và parse được", () => {
    assert.equal(LIMIT_DEFAULTS.toolOutputChars, 8_000);
    assert.equal(LIMIT_DEFAULTS.mcpSchemaTokens, 0, "mặc định TẮT trần schema (không đổi hành vi cũ)");
    assert.equal(LIMIT_DEFAULTS.buildTimeoutSecs, 600);
    writeFileSync(join(dir, ".scoderrc.json"), JSON.stringify({
      limits: { toolOutputChars: 6000, mcpSchemaTokens: 4000, buildTimeoutSecs: 120 },
    }));
    const cfg = loadConfig({ workdir: dir, ...base });
    assert.deepEqual(cfg.limits, { toolOutputChars: 6000, mcpSchemaTokens: 4000, buildTimeoutSecs: 120 });
  });

  it("P0-3: mcpSchemaTokens = 0 là giá trị hợp lệ (tắt trần), số âm bị bỏ", () => {
    writeFileSync(join(dir, ".scoderrc.json"), JSON.stringify({ limits: { mcpSchemaTokens: 0 } }));
    assert.equal(loadConfig({ workdir: dir, ...base }).limits.mcpSchemaTokens, 0);
    writeFileSync(join(dir, ".scoderrc.json"), JSON.stringify({ limits: { mcpSchemaTokens: -1 } }));
    assert.equal(loadConfig({ workdir: dir, ...base }).limits, undefined);
  });
});

describe("rc keys mới (P0-3 / P1-2 / P2)", () => {
  it("mcpTools + verifyCache + contextWindow đọc từ rc", () => {
    writeFileSync(join(dir, ".scoderrc.json"), JSON.stringify({
      mcpTools: { include: ["mcp__github-mcp__get_*"], exclude: ["mcp__github-mcp__*write*"] },
      verifyCache: false,
      contextWindow: 32768,
      localProfile: false,
    }));
    const cfg = loadConfig({ workdir: dir, ...base });
    assert.deepEqual(cfg.mcpTools.include, ["mcp__github-mcp__get_*"]);
    assert.equal(cfg.verifyCache, false);
    assert.equal(cfg.contextWindow, 32768);
    assert.equal(cfg.localProfile, false);
  });
});

describe("isLocalBaseUrl (P2)", () => {
  it("loopback + .local = local; cloud = không", () => {
    assert.equal(isLocalBaseUrl("http://localhost:11434/v1"), true);
    assert.equal(isLocalBaseUrl("http://127.0.0.1:8080/v1"), true);
    assert.equal(isLocalBaseUrl("http://[::1]:11434/v1"), true);
    assert.equal(isLocalBaseUrl("http://mybox.local:11434"), true);
    assert.equal(isLocalBaseUrl("https://api.openai.com/v1"), false);
    assert.equal(isLocalBaseUrl("http://x"), false);
    assert.equal(isLocalBaseUrl("not a url"), false);
  });
});

describe("applyLocalProfile (P2)", () => {
  it("local: hạ maxSteps, bật timeout/ngân sách nhỏ, tắt selfReview", () => {
    const cfg = { ...base, baseUrl: "http://localhost:11434/v1", maxSteps: 40 };
    const applied = applyLocalProfile(cfg, { maxSteps: false });
    assert.equal(cfg.maxSteps, LOCAL_PROFILE_DEFAULTS.maxSteps);
    assert.equal(cfg.limits.requestTimeoutMs, LOCAL_PROFILE_DEFAULTS.requestTimeoutMs);
    assert.equal(cfg.limits.toolOutputChars, LOCAL_PROFILE_DEFAULTS.toolOutputChars);
    assert.equal(cfg.limits.mcpSchemaTokens, LOCAL_PROFILE_DEFAULTS.mcpSchemaTokens);
    assert.equal(cfg.selfReview, false);
    assert.ok(applied.length >= 4, applied.join(","));
  });

  it("cloud: không đổi gì", () => {
    const cfg = { ...base, maxSteps: 40 };
    assert.deepEqual(applyLocalProfile(cfg, { maxSteps: false }), []);
    assert.equal(cfg.maxSteps, 40);
    assert.equal(cfg.limits, undefined);
    assert.equal(cfg.selfReview, undefined);
  });

  it("tôn trọng maxSteps user đặt tường minh và localProfile:false", () => {
    const cfg = { ...base, baseUrl: "http://localhost:11434/v1", maxSteps: 100 };
    applyLocalProfile(cfg, { maxSteps: true });
    assert.equal(cfg.maxSteps, 100, "user đặt rõ ràng thì không hạ");
    const off = { ...base, baseUrl: "http://localhost:11434/v1", maxSteps: 40, localProfile: false };
    assert.deepEqual(applyLocalProfile(off, { maxSteps: false }), []);
    assert.equal(off.maxSteps, 40);
  });

  it("loadConfig: rc local + limits tự áp, ghi đè được từng key", () => {
    writeFileSync(join(dir, ".scoderrc.json"), JSON.stringify({
      baseUrl: "http://localhost:11434/v1",
      limits: { toolOutputChars: 3000 },
    }));
    const cfg = loadConfig({ workdir: dir, apiKey: "k", model: "m", provider: "openai" });
    assert.equal(cfg.limits.toolOutputChars, 3000, "key user đặt không bị profile ghi đè");
    assert.equal(cfg.limits.mcpSchemaTokens, LOCAL_PROFILE_DEFAULTS.mcpSchemaTokens);
  });
});
