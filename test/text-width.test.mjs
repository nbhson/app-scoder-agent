/**
 * text-width.ts — display-cell measuring/clipping/padding/wrapping.
 * Covers: Vietnamese combining marks, emoji (incl. ZWJ), CJK wide chars,
 * ANSI passthrough, grapheme safety.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  measure,
  clipCells,
  sliceCells,
  padEndCells,
  padStartCells,
  wrapCells,
} from "../dist/tui/text-width.js";

describe("measure", () => {
  it("ASCII = length", () => assert.equal(measure("hello"), 5));
  it("precomposed Vietnamese = 1 cell/char", () => assert.equal(measure("hế"), 2));
  it("combining marks = 0 cells", () => assert.equal(measure("e\u0301"), 1)); // e + ◌́
  it("emoji = 2 cells", () => assert.equal(measure("👋"), 2));
  it("ZWJ sequence = 2 cells", () => assert.equal(measure("👨‍👩‍👧"), 2));
  it("CJK = 2 cells", () => assert.equal(measure("中文"), 4));
  it("ANSI ignored", () => assert.equal(measure("\x1b[31mred\x1b[0m"), 3));
  it("mixed string", () => assert.equal(measure("hế lộ 👋 中文"), 13));
});

describe("clipCells", () => {
  it("keeps short text", () => assert.equal(clipCells("abc", 5), "abc"));
  it("truncates with ellipsis within width", () => {
    const out = clipCells("abcdefgh", 5);
    assert.equal(out, "abcd…");
    assert.equal(measure(out), 5);
  });
  it("never splits a grapheme cluster", () => {
    const out = clipCells("a\u0301bcd", 3); // á(1) b(1) c(1) d(1) = 4 cells > 3
    assert.equal(out, "a\u0301b…");
    assert.equal(measure(out), 3);
  });
  it("counts emoji as 2 cells", () => {
    const out = clipCells("a👋b👋c", 5);
    assert.ok(measure(out) <= 5);
    assert.ok(out.endsWith("…"));
  });
  it("preserves ANSI sequences", () => {
    const out = clipCells("\x1b[31mabcdef\x1b[0m", 4);
    assert.ok(out.startsWith("\x1b[31m"));
    assert.ok(out.endsWith("…"));
  });
});

describe("sliceCells", () => {
  it("no ellipsis", () => assert.equal(sliceCells("abcdef", 3), "abc"));
  it("never splits wide char", () => assert.equal(sliceCells("a中b", 2), "a"));
  it("zero width → empty", () => assert.equal(sliceCells("abc", 0), ""));
});

describe("pad*Cells", () => {
  it("padEnd by cells with emoji", () => {
    const out = padEndCells("👋a", 5);
    assert.equal(out, "👋a  ");
    assert.equal(measure(out), 5);
  });
  it("padStart by cells with CJK", () => {
    const out = padStartCells("中", 4);
    assert.equal(out, "  中");
    assert.equal(measure(out), 4);
  });
  it("no pad when already at width", () => assert.equal(padEndCells("abcde", 5), "abcde"));
});

describe("wrapCells", () => {
  it("wraps at word boundary", () => {
    assert.deepEqual(wrapCells("hello world foo", 8), ["hello", "world", "foo"]);
  });
  it("hard-breaks long words", () => {
    const out = wrapCells("abcdefghij", 4);
    assert.deepEqual(out, ["abcd", "efgh", "ij"]);
    for (const line of out) assert.ok(measure(line) <= 4);
  });
  it("wraps CJK by cells", () => {
    const out = wrapCells("中文中文中", 5);
    for (const line of out) assert.ok(measure(line) <= 5);
    assert.equal(out.join("").replace(/\s/g, ""), "中文中文中");
  });
  it("preserves short lines and newlines", () => {
    assert.deepEqual(wrapCells("ab\ncd", 10), ["ab", "cd"]);
  });
  it("empty line stays", () => {
    assert.deepEqual(wrapCells("a\n\nb", 10), ["a", "", "b"]);
  });
});
