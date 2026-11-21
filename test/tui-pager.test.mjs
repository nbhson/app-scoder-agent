/**
 * P3 — full-screen viewer: word-diff pre-pass (pure), pager source stack,
 * and a render smoke test (Ink → PassThrough, ANSI stripped).
 * Chạy: node --test test/tui-pager.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import stringWidth from "string-width";
import { wordDiff, wlineText } from "../dist/tui/word-diff.js";
import { pagerSources, Pager } from "../dist/tui/pager.js";

// ── word-diff ───────────────────────────────────────────────────────────────

describe("word-diff — segments", () => {
  it("lossless: joining every line reproduces the input", () => {
    const src = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      " const alpha = 1",
      "-const beta = compute(a, b)",
      "+const beta = compute(a, c, b)",
      "  ctx line",
      "-gone",
    ].join("\n");
    const lines = wordDiff(src);
    const back = lines.map(wlineText).join("\n");
    assert.equal(back, src);
  });

  it("paired -/+ lines split into prefix / changed / suffix segments", () => {
    const lines = wordDiff("-foo bar baz\n+foo QUX baz");
    assert.equal(lines.length, 2);
    const del = lines[0];
    const add = lines[1];
    assert.equal(del.kind, "del");
    assert.equal(add.kind, "add");
    const changed = (l) => l.segs.filter((s) => s.op !== "eq").map((s) => s.text);
    assert.deepEqual(changed(del), ["bar"]);
    assert.deepEqual(changed(add), ["QUX"]);
    // common prefix/suffix preserved as eq
    assert.equal(del.segs[0].op, "eq");
    assert.equal(del.segs[0].text, "foo ");
    assert.equal(del.segs.at(-1).text, " baz");
  });

  it("pure insertion: only the + line gets a changed run", () => {
    const lines = wordDiff("-const beta = compute(a, b)\n+const beta = compute(a, c, b)");
    const changed = (l) => l.segs.filter((s) => s.op !== "eq").map((s) => s.text);
    assert.deepEqual(changed(lines[0]), []);
    assert.deepEqual(changed(lines[1]), ["c, "]);
    assert.equal(wlineText(lines[1]), "+const beta = compute(a, c, b)");
  });

  it("unpaired runs stay fully-highlighted; context/headers are raw", () => {
    const lines = wordDiff("+++ b/y\nsome context\n-only removed\n");
    assert.equal(lines[0].kind, "raw");
    assert.equal(lines[1].kind, "raw");
    assert.equal(lines[2].kind, "del");
    assert.equal(lines[2].segs.length, 1);
    assert.equal(lines[2].segs[0].op, "del");
  });
});

// ── pager sources ───────────────────────────────────────────────────────────

describe("pager — source stack", () => {
  const tool = { kind: "tool", name: "run_command", args: { command: "npm test" }, ok: true, output: "a".repeat(50), step: 7 };
  const diff = { kind: "diff", path: "src/a.ts", text: "-x\n+y", added: 1, removed: 1, truncated: false, step: 8 };
  it("collects tool + diff items in order, capped to the newest", () => {
    const items = [{ kind: "user", text: "hi" }, tool, diff];
    const src = pagerSources(items);
    assert.equal(src.length, 2);
    assert.equal(src[0].kind, "output");
    assert.match(src[0].title, /07 ▸ run_command npm test/);
    assert.equal(src[1].kind, "diff");
    assert.equal(src[1].itemId, 2, "itemId points back into state.items");
    const many = Array.from({ length: 50 }, (_, i) => ({ ...tool, step: i }));
    assert.equal(pagerSources(many, 30).length, 30);
    assert.equal(pagerSources(many, 30)[29].itemId, 49);
  });
});

// ── pager render ────────────────────────────────────────────────────────────

describe("pager — render", () => {
  it("paints header + body + hints, no row over the width", async () => {
    const stream = new PassThrough();
    stream.columns = 100;
    stream.rows = 30;
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    let out = "";
    stream.on("data", (c) => (out += String(c)));
    const sources = pagerSources([
      { kind: "tool", name: "run_command", args: {}, ok: false, output: "line one\nline two", step: 3 },
      { kind: "diff", path: "f.ts", text: "-const a = 1\n+const a = 2", added: 1, removed: 1, truncated: false, step: 4 },
    ]);
    const app = render(
      React.createElement(Pager, {
        sources,
        startIndex: 1,
        wheelRef: { current: null },
        onSave: () => {},
        onClose: () => {},
      }),
      { stdout: stream, stderr: stream, stdin, patchConsole: false, exitOnCtrlC: false },
    );
    await new Promise((r) => setTimeout(r, 80));
    app.unmount();
    await app.waitUntilExit();
    const text = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
    assert.match(text, /✎ f\.ts/);
    assert.match(text, /· 2\/2/);
    assert.match(text, /w word\/raw/);
    assert.match(text, /y save/);
    assert.match(text, /const a/);
    for (const line of text.split("\n")) {
      assert.ok(stringWidth(line) <= 100, `row overflow: ${line}`);
    }
  });
});
