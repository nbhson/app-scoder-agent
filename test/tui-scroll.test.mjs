/**
 * P4 — scroll affordances: pure helpers cho new-content pill + scroll thumb.
 * Chạy: node --test test/tui-scroll.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newContentPill, scrollThumb } from "../dist/tui/scrollbar.js";

describe("newContentPill", () => {
  it("counts growth only while scrolled up", () => {
    assert.equal(newContentPill(100, 107, 5), 7);
    assert.equal(newContentPill(100, 107, 0), 0, "at the bottom — never nag");
  });
  it("ignores re-estimates/shrink", () => {
    assert.equal(newContentPill(100, 100, 5), 0);
    assert.equal(newContentPill(100, 92, 5), 0);
  });
});

describe("scrollThumb", () => {
  it("null when nothing to scroll or track too small", () => {
    assert.equal(scrollThumb(20, 20, 0), null);
    assert.equal(scrollThumb(20, 19, 0), null);
    assert.equal(scrollThumb(2, 100, 5), null);
  });
  it("thumb length ≈ viewport/content, clamped ≥ 1", () => {
    const t = scrollThumb(20, 100, 0);
    assert.equal(t.cells.filter(Boolean).length, Math.max(1, Math.round((20 * 20) / 100)));
    const huge = scrollThumb(20, 2000, 0);
    assert.equal(huge.cells.filter(Boolean).length, 1);
  });
  it("bottom (offset 0) → thumb at the track end; top → thumb at the start", () => {
    const bottom = scrollThumb(20, 100, 0);
    assert.equal(bottom.cells[19], true);
    assert.equal(bottom.cells[0], false);
    const top = scrollThumb(20, 100, 80); // maxOffset = totalRows - track
    assert.equal(top.cells[0], true);
    assert.equal(top.cells[19], false);
    assert.equal(top.pct, 0, "at the top — nothing read past the viewport");
    assert.equal(bottom.pct, Math.round(((80 - 0) / 80) * 100), "bottom = 100% read");
  });
  it("clamps an overshot offset into the track", () => {
    const t = scrollThumb(20, 100, 500);
    assert.equal(t.cells.filter(Boolean).length, 4);
    assert.equal(t.cells[0], true);
  });
});
