/**
 * Unit tests cho model catalog (I-02).
 * Chạy: node --test test/model-catalog.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contextWindowFor, lookupModel } from "../dist/model-catalog.js";

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
    const { loadCatalog } = await import("../dist/model-catalog.js");
    const r = await loadCatalog(true); // force → thử network; offline → fallback
    assert.ok(r.models);
    assert.ok(["cache", "network", "fallback"].includes(r.source));
    assert.ok(Object.keys(r.models).length >= 20, "≥20 models từ network hoặc fallback");
  });
});
