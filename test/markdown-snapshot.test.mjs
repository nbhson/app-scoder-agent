/**
 * Markdown render snapshot tests — render every fixture in
 * test/fixtures/markdown/ at several pane widths through the REAL Ink
 * renderer (PassThrough stdout), strip ANSI, and compare with committed
 * snapshots in test/snapshots/markdown/.
 *
 * Invariants asserted on every render (beyond the snapshot):
 * - no visible line exceeds the pane width (Unicode/emoji-safe, measured in
 *   display cells via text-width);
 * - renderer never throws.
 *
 * Regenerate snapshots:  UPDATE_SNAPSHOTS=1 npm run build && UPDATE_SNAPSHOTS=1 node --test test/markdown-snapshot.test.mjs
 * (review the diff in test/snapshots/ before committing)
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import React from "react";

// Force deterministic charset/colors BEFORE importing dist modules
// (charset.ts resolves ASCII mode at module load).
process.env.TERM = "xterm-256color";
delete process.env.SCODER_ASCII;
process.env.FORCE_COLOR = "1";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures", "markdown");
const SNAPSHOTS = join(here, "snapshots", "markdown");
const WIDTHS = [40, 80, 120];
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

let Markdown;
let measure;

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

async function renderMarkdown(text, width) {
  const { render } = await import("ink");
  const stream = new PassThrough();
  stream.columns = width;
  stream.rows = 500;
  let out = "";
  stream.on("data", (c) => (out += String(c)));
  const app = render(React.createElement(Markdown, { text, width }), {
    stdout: stream,
    stderr: stream,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise((r) => setTimeout(r, 80));
  app.unmount();
  await app.waitUntilExit();
  // Collapse Ink's repaint blank-line runs for stable snapshots.
  return stripAnsi(out).replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

before(async () => {
  ({ Markdown } = await import("../dist/tui/markdown.js"));
  ({ measure } = await import("../dist/tui/text-width.js"));
  mkdirSync(SNAPSHOTS, { recursive: true });
});

const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".md")).sort();

describe("markdown snapshots", () => {
  for (const fixture of fixtures) {
    const name = fixture.replace(/\.md$/, "");
    for (const width of WIDTHS) {
      it(`${name} @ ${width}c`, async () => {
        const text = readFileSync(join(FIXTURES, fixture), "utf8");
        const out = await renderMarkdown(text, width);

        // Invariant: no visible line overflows the pane width.
        for (const line of out.split("\n")) {
          assert.ok(
            measure(line) <= width,
            `line overflows ${width}c (${measure(line)}c): ${JSON.stringify(line.slice(0, 60))}`,
          );
        }

        const snapPath = join(SNAPSHOTS, `${name}-${width}.txt`);
        if (UPDATE || !existsSync(snapPath)) {
          writeFileSync(snapPath, out + "\n");
          if (!UPDATE) assert.fail(`snapshot created: ${snapPath} — review & re-run`);
          return;
        }
        assert.equal(out + "\n", readFileSync(snapPath, "utf8"), `snapshot mismatch: ${snapPath} (regenerate with UPDATE_SNAPSHOTS=1)`);
      });
    }
  }
});
