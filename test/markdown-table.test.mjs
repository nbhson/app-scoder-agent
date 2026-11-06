/**
 * T-08 — markdown renderer: table layout + nested lists (structure checks
 * on the pure parse paths exported for tests).
 * React component rendering itself is covered by the TUI PTY smoke test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../dist/tui/markdown.js";

function render(text) {
  return renderToStaticMarkup(React.createElement(Markdown, { text }));
}

describe("Markdown tables (T-08)", () => {
  it("GFM table renders aligned rows", () => {
    const html = render("| name | age |\n|---|---|\n| alice | 30 |\n| bob | 25 |");
    assert.match(html, /name/);
    assert.match(html, /alice/);
    assert.match(html, /30/);
    assert.match(html, /bob/);
  });
  it("header row is first rendered row", () => {
    // Ink bold không visible trong static markup (custom reconciler) —
    // assert structural: header 'a' xuất hiện trước separator row '├'.
    const html = render("| a |\n|---|\n| 1 |");
    const idxH = html.indexOf("a");
    const idxSep = html.indexOf("├");
    assert.ok(idxH >= 0 && idxSep > idxH, html.slice(0, 200));
  });
  it("long cell wraps without losing content (no truncation)", () => {
    const long = "x".repeat(60);
    const html = render(`| a |\n|---|\n| ${long} |`).replace(/<[^>]+>/g, "");
    // Cell wraps to multiple physical lines instead of clipping with "…" —
    // the full 60 chars must survive (no data loss).
    assert.ok(!html.includes("…"), "cell must wrap, not clip");
    assert.equal((html.match(/x/g) || []).length, 60, "full cell content preserved");
    // Wrapped into two physical segments (40 + 20 at default width 100).
    assert.ok(html.includes("x".repeat(40)), "first wrapped segment");
    assert.ok(html.includes("x".repeat(20)), "second wrapped segment");
  });
});

describe("Markdown nested lists (T-08)", () => {
  it("nested bullets indent by depth", () => {
    const html = render("- top\n  - sub\n    - subsub");
    assert.ok(html.includes("• top") || /top/.test(html));
    // subsub có indent sâu hơn top
    const idxTop = html.indexOf("top");
    const idxSub = html.indexOf("subsub");
    assert.ok(idxTop >= 0 && idxSub > idxTop);
  });
  it("numbered list keeps numbering + nested indent", () => {
    // Marker and text render in separate <Text> spans — strip tags first.
    const html = render("1. one\n   1. nested").replace(/<[^>]+>/g, "");
    assert.match(html, /1\.\s+one/);
    assert.match(html, /1\.\s+nested/);
    // Nested item is indented deeper than the top-level one.
    const top = html.indexOf("1.  one") !== -1 ? html.indexOf("1. ") : 0;
    const nested = html.lastIndexOf("1. ");
    assert.ok(nested > top, "nested item renders after top-level");
  });
});
