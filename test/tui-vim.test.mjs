/**
 * T5: vim-motion + mouse wheel — module thuần.
 * Chạy: node --test test/tui-vim.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wordForward, wordBack, wordEnd, applyNormalKey } from "../dist/tui/vim.js";
import { parseWheel } from "../dist/tui/mouse.js";

describe("vim motions (T5)", () => {
  it("w: đầu từ kế tiếp", () => {
    assert.equal(wordForward("foo bar baz", 0), 4);
    assert.equal(wordForward("foo bar", 4), 7);
    assert.equal(wordForward("foo", 0), 3); // clamp cuối
  });

  it("b: đầu từ trước", () => {
    assert.equal(wordBack("foo bar baz", 8), 4);
    assert.equal(wordBack("foo bar", 4), 0);
    assert.equal(wordBack("foo", 0), 0);
  });

  it("e: cuối từ", () => {
    assert.equal(wordEnd("foo bar", 0), 2);
    assert.equal(wordEnd("foo bar", 2), 6);
  });

  it("normal keys: h/l/0/$/x/i/a/A", () => {
    const r = (inp, value = "hello world", cursor = 6) => applyNormalKey(value, cursor, inp);
    assert.deepEqual({ v: r("h").cursor, u: r("h").value }, { v: 5, u: "hello world" });
    assert.equal(r("l").cursor, 7);
    assert.equal(r("w").cursor, 11);
    assert.equal(r("b").cursor, 0);
    assert.equal(r("0").cursor, 0);
    assert.equal(r("$").cursor, 11);
    assert.deepEqual(r("x"), { value: "hello orld", cursor: 6, mode: "normal", unhandled: false });
    assert.equal(r("i").mode, "insert");
    assert.equal(r("a").mode, "insert");
    assert.equal(r("a").cursor, 7);
    assert.equal(r("A").mode, "insert");
    assert.equal(r("A").cursor, 11);
  });

  it("phím lạ → unhandled", () => {
    assert.equal(applyNormalKey("hello", 0, "z").unhandled, true);
  });

  it("x ở cuối chuỗi → không xoá", () => {
    const r = applyNormalKey("hi", 2, "x");
    assert.equal(r.value, "hi");
  });
});

describe("mouse wheel SGR (T5)", () => {
  it("64=up, 65=down, khác → null", () => {
    assert.equal(parseWheel("\x1b[<64;10;5M"), "up");
    assert.equal(parseWheel("\x1b[<65;10;5M"), "down");
    assert.equal(parseWheel("\x1b[<0;10;5M"), null); // click trái
    assert.equal(parseWheel("hello"), null);
    assert.equal(parseWheel(""), null);
  });
});
