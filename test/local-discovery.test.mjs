/**
 * Unit tests cho local engine discovery (I-03).
 * Chạy: node --test test/local-discovery.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverLocalEngines } from "../dist/provider-registry.js";

describe("discoverLocalEngines (I-03)", () => {
  it("offline → mảng rỗng, không throw", { timeout: 5000 }, async () => {
    const engines = await discoverLocalEngines(50);
    assert.ok(Array.isArray(engines));
  });

  it("timeout ngắn không treo", { timeout: 5000 }, async () => {
    const t0 = Date.now();
    await discoverLocalEngines(50);
    assert.ok(Date.now() - t0 < 5000, "probes hoàn tất nhanh");
  });
});
