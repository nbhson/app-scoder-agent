/**
 * Unit tests cho model catalog (I-02).
 * Chạy: node --test test/model-catalog.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contextWindowFor, lookupModel } from "../dist/llm/model-catalog.js";

describe("lookupModel — sync lookup (cache hoặc fallback)", () => {
  it("known model trả về metadata hợp lệ", () => {
    const m = lookupModel("openai", "gpt-4o-mini");
    assert.ok(m);
    assert.ok(m.contextWindow > 0);
  });
  it("unknown → null (không throw)", () => {
    assert.equal(lookupModel("openai", "totally-fake-model-xyz"), null);
  });
});

describe("contextWindowFor", () => {
  it("known model > 0", () => {
    assert.ok(contextWindowFor("openai", "gpt-4o") > 0);
  });
  it("unknown → 128k fallback", () => {
    assert.equal(contextWindowFor("nope", "nope"), 128_000);
  });
});

describe("loadCatalog — cache/network/fallback chain", () => {
  it("không bao giờ throw, trả về models + source", async () => {
    const { loadCatalog } = await import("../dist/llm/model-catalog.js");
    const r = await loadCatalog(true); // force → thử network; offline → fallback
    assert.ok(r.models);
    assert.ok(["cache", "network", "fallback"].includes(r.source));
    assert.ok(Object.keys(r.models).length >= 20, "≥20 models từ network hoặc fallback");
  });
});

describe("registerConfigModels (P2.1) — config luôn thắng cache/fallback", () => {
  it("ctx + pricing từ rc config đè catalog; kind alias để sidebar tra; reset sạch", async () => {
    const { registerConfigModels, getConfigModels } = await import("../dist/llm/model-catalog.js");
    registerConfigModels({
      "box-api/qwen3.8-flash": { id: "qwen3.8-flash", provider: "box-api", contextWindow: 262144, pricing: { input: 0.2, output: 0.8 } },
      "openai/qwen3.8-flash": { id: "qwen3.8-flash", provider: "box-api", contextWindow: 262144, pricing: { input: 0.2, output: 0.8 } },
    });
    assert.equal(contextWindowFor("openai", "qwen3.8-flash"), 262144); // alias kind — config provider không phải kind "openai"
    assert.equal(lookupModel("box-api", "qwen3.8-flash").pricing.output, 0.8);
    // Model catalogue thường không bị ảnh hưởng:
    assert.equal(contextWindowFor("openai", "gpt-4o-mini"), 128_000);
    // Replace semantics: lần register sau thay toàn bộ map.
    registerConfigModels({});
    assert.deepEqual(getConfigModels(), {});
    assert.equal(lookupModel("openai", "qwen3.8-flash"), null);
  });
});
