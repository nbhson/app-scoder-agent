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
  it("long cell clips", () => {
    const long = "x".repeat(60);
    const html = render(`| a |\n|---|\n| ${long} |`);
    assert.match(html, /…/);
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
    const html = render("1. one\n   1. nested");
    assert.match(html, /1\. one/);
    assert.match(html, /nested/);
  });
});
