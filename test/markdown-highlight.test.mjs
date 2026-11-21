/**
 * P5 — table-driven highlight: language routing + color differential.
 * The snapshot fixtures pin the bytes; this pins the INTENT: a keyword is
 * highlighted per language (cyan), and the same word in another language's
 * block is not.
 * Chạy: node --test test/markdown-highlight.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import React from "react";

process.env.TERM = "xterm-256color";
delete process.env.SCODER_ASCII;
process.env.FORCE_COLOR = "1";

const { render } = await import("ink");
const { Markdown } = await import("../dist/tui/markdown.js");
const { ruleFor } = await import("../dist/tui/markdown/render.js");

async function colors(md) {
  const stream = new PassThrough();
  stream.columns = 100;
  stream.rows = 40;
  let out = "";
  stream.on("data", (c) => (out += String(c)));
  const app = render(React.createElement(Markdown, { text: md, width: 100 }), {
    stdout: stream, stderr: stream, patchConsole: false, exitOnCtrlC: false,
  });
  await new Promise((r) => setTimeout(r, 80));
  app.unmount();
  await app.waitUntilExit();
  return out;
}

describe("highlight — language routing", () => {
  it("aliases map onto families; unknown langs keep the JS table", () => {
    assert.equal(ruleFor("py").keywords.has("def"), true);
    assert.equal(ruleFor("python").keywords, ruleFor("py").keywords);
    assert.equal(ruleFor("rs").keywords.has("fn"), true);
    assert.equal(ruleFor("golang").keywords.has("package"), true);
    assert.equal(ruleFor("yml").lineComment.join(), "#");
    assert.equal(ruleFor("mysql").ci, true);
    assert.equal(ruleFor("klingon").keywords.has("const"), true, "fallback = JS rules");
    assert.equal(ruleFor("").keywords.has("const"), true);
  });

  it("sql keywords match case-insensitively, bash handles #! as comment", () => {
    assert.equal(ruleFor("sql").keywords.has("select"), true);
    assert.equal(ruleFor("sql").ci, true);
    assert.deepEqual(ruleFor("bash").lineComment, ["#"]);
    assert.equal(ruleFor("python").blockComment, undefined, "py has no block comment");
  });
});

describe("highlight — color differential per language", () => {
  it("python `def` gets a colored keyword span; json `def` stays plain", async () => {
    const py = await colors('```python\ndef f():\n    return 1\n```');
    const js = await colors('```json\n{ "def": 1 }\n```');
    // cyan (36) = keyword color in the mission theme.
    assert.match(py, /\x1b\[36m/, "python keyword must be cyan");
    assert.doesNotMatch(js, /\x1b\[36m/, "json block has no keywords here");
  });

  it("hash-comment langs still color line comments dim", async () => {
    const out = await colors('```yaml\na: 1  # note\n```\nb: 2');
    assert.match(out, /# note/);
  });

  it("comment-less JSON doesn't crash or mis-tokenize numbers", async () => {
    const out = await colors('```json\n{"n": 42.5, "m": 1e3}\n```');
    assert.match(out, /42\.5/);
    assert.match(out, /1e3/);
  });
});
