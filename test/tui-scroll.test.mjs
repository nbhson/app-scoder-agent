/**
 * P4 — scroll affordances: pure helpers cho new-content pill + scroll thumb.
 * Chạy: node --test test/tui-scroll.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newContentPill, scrollThumb, tailAnchor } from "../dist/tui/scrollbar.js";

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

describe("tailAnchor", () => {
  // The reported bug: the row ESTIMATE over-counts real rows (wide terminals),
  // so the estimated bottom sits past the true one. Scrolling back down with
  // offset > 0 used winOffset blindly → contentOffset buried the last line
  // mid-screen, blank below, pill still nagging "+N new lines".
  const overcount = {
    track: 20,
    totalRows: 200, // estimate; real transcript is shorter
    maxScroll: 180,
    winOffset: 25, // estimate rows hidden above the mounted window
    contentHeight: 30, // measured window: only 30 real rows, tail included
    hasMeasured: true,
    tailMounted: true,
  };

  it("pins the measured bottom when winOffset hides rows past the content end", () => {
    const a = tailAnchor({ ...overcount, offset: 30 });
    assert.equal(a.contentOffset, 10, "contentHeight - track → last line at the viewport bottom");
    assert.equal(a.offset, 0, "at-bottom for pill/thumb/status");
    assert.equal(a.totalRows, 155, "real total = estimate above window (125) + measured window (30)");
  });

  it("leaves a normal scrolled-up view untouched", () => {
    const a = tailAnchor({ ...overcount, winOffset: 5, offset: 30 });
    assert.equal(a.contentOffset, 5, "winOffset below the measured bottom → no pin");
    assert.equal(a.offset, 30);
  });

  it("hides the phantom rail when a short transcript fits (estimate says otherwise)", () => {
    // 15 real rows but the estimate claims 100: offset 9 → winOffset 71.
    const a = tailAnchor({
      track: 20, totalRows: 100, maxScroll: 80, offset: 9,
      winOffset: 71, contentHeight: 15, hasMeasured: true, tailMounted: true,
    });
    assert.equal(a.contentOffset, 0, "content pinned to the top — nothing to scroll");
    assert.equal(a.offset, 0);
    assert.equal(a.totalRows, 20, "clamped ≥ track ⇒ scrollThumb returns null ⇒ rail hidden");
  });

  it("falls back to the estimate while unmeasured or scrolled deep up", () => {
    const unmeasured = tailAnchor({ ...overcount, offset: 30, hasMeasured: false });
    assert.equal(unmeasured.contentOffset, 25, "pre-measurement frame keeps winOffset");
    assert.equal(unmeasured.offset, 30);
    assert.equal(unmeasured.totalRows, 200);
    const farUp = tailAnchor({ ...overcount, offset: 120, tailMounted: false, winOffset: 40 });
    assert.equal(farUp.contentOffset, 40, "window above the tail — estimate scroll untouched");
    assert.equal(farUp.offset, 120);
    assert.equal(farUp.totalRows, 200);
  });

  it("clamps Home-style overshot offsets (topEst never negative)", () => {
    const a = tailAnchor({ ...overcount, winOffset: 5, offset: 999_999 });
    assert.equal(a.contentOffset, 5);
    assert.equal(a.totalRows, 25, "topEst clamped to 0 → 0 - 5 + 30, no negative scroll math");
  });
});
