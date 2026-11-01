/**
 * G7: rc "limits" — parse + validate + defaults.
 * Chạy: node --test test/limits.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, LIMIT_DEFAULTS, resolveLimits } from "../dist/config.js";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limits-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
});
