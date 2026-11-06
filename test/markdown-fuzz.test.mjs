/**
 * Fuzz test cho markdown renderer: sinh ngẫu nhiên (deterministic PRNG) các
 * document markdown "rách" — fence không đóng, bảng thiếu cột, unicode/emoji
 * hỗn loạn — và assert 2 invariant:
 *   1. renderer không throw;
 *   2. mọi dòng output (strip ANSI) không vượt quá pane width.
 *
 * Chạy: node --test test/markdown-fuzz.test.mjs (sau khi npm run build)
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import React from "react";

process.env.TERM = "xterm-256color";
delete process.env.SCODER_ASCII;
process.env.FORCE_COLOR = "1";

let Markdown;
let measure;

/** mulberry32 — deterministic PRNG so failures are reproducible. */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "# Heading", "## Sub", "```js", "```", "```mermaid", "graph TD", "A-->B",
  "| a | b |", "|---|---|", "| x", "| ✅ | 中文 |", "- item", "- [x] done",
  "1. one", "   - nested", "> quote", "---", "***", "**bold**", "*it*",
  "`code`", "[l](http://x.y/(z))", "~~del~~", "\\| escaped \\|", "`a|b`",
  "é combining", "👋 emoji", "中文 wide", "x".repeat(120),
  "pie", "gantt", "    indented", "a \\* not bold", "|:-:|-:|",
  "sequenceDiagram", "A->>B: msg", "‖", "\t tab indent",
];

function randomDoc(rand) {
  const n = 3 + Math.floor(rand() * 25);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]);
  return lines.join("\n");
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

async function renderOnce(text, width) {
  const { render } = await import("ink");
  const stream = new PassThrough();
  stream.columns = width;
  stream.rows = 2000;
  let out = "";
  stream.on("data", (c) => (out += String(c)));
  const app = render(React.createElement(Markdown, { text, width }), {
    stdout: stream, stderr: stream, patchConsole: false, exitOnCtrlC: false,
  });
  await new Promise((r) => setTimeout(r, 25));
  app.unmount();
  await app.waitUntilExit();
  return stripAnsi(out);
}

before(async () => {
  ({ Markdown } = await import("../dist/tui/markdown.js"));
  ({ measure } = await import("../dist/tui/text-width.js"));
});

describe("markdown fuzz", () => {
  for (const [seed, width] of [[1, 40], [2, 80], [3, 120], [4, 34]]) {
    it(`60 random docs @ ${width}c (seed ${seed}) — no throw, no overflow`, async () => {
      const rand = rng(seed);
      for (let i = 0; i < 60; i++) {
        const doc = randomDoc(rand);
        let out;
        try {
          out = await renderOnce(doc, width);
        } catch (err) {
          assert.fail(`renderer threw on doc #${i} (seed ${seed}, width ${width}):\n${doc}\n\n${err.stack}`);
        }
        for (const line of out.split("\n")) {
          if (measure(line) > width) {
            assert.fail(`overflow @${width}c (seed ${seed}, doc #${i}): ${measure(line)}c — ${JSON.stringify(line.slice(0, 80))}\n--- doc ---\n${doc}`);
          }
        }
      }
    });
  }
});
