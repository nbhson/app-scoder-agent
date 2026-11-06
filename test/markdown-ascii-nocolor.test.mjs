/**
 * Terminal fallbacks:
 * 1. SCODER_ASCII=1 → only printable ASCII in rendered output (no box-drawing
 *    chars, no block chars, no Braille spinner).
 * 2. NO_COLOR=1 → no ANSI SGR color sequences in rendered output.
 *
 * Child-process tests because charset/color levels resolve at module load.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function renderInChild(env) {
  // Script phải nằm TRONG project để resolve được bare imports (react/ink).
  const script = join(here, `.md-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  const mdPath = join(here, "..", "dist", "tui", "markdown.js").replace(/\\/g, "/");
  writeFileSync(script, `
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { Markdown } from ${JSON.stringify("file://" + mdPath)};
const stream = new PassThrough();
stream.columns = 60; stream.rows = 100;
let out = "";
stream.on("data", (c) => (out += String(c)));
const text = "| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n# Title\\n\\n- item\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`\\n";
const app = render(React.createElement(Markdown, { text, width: 50 }), { stdout: stream, stderr: stream, patchConsole: false, exitOnCtrlC: false });
setTimeout(() => { app.unmount(); }, 80);
app.waitUntilExit().then(() => { process.stdout.write(out); });
`);
  try {
    const res = spawnSync(process.execPath, [script], {
      env: { ...process.env, TERM: "xterm-256color", ...env },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  } finally {
    unlinkSync(script);
  }
}

describe("terminal fallbacks", () => {
  it("SCODER_ASCII=1 → chỉ ký tự ASCII in được trong output", () => {
    const out = renderInChild({ SCODER_ASCII: "1", FORCE_COLOR: "0" });
    const stripped = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    // Không còn box-drawing / block / Braille — chỉ ASCII in được + newline.
    const nonAscii = [...stripped].filter((ch) => ch !== "\n" && (ch < " " || ch > "~"));
    assert.deepEqual(nonAscii, [], `ký tự non-ASCII còn sót: ${nonAscii.slice(0, 10).join(" ")}`);
    // Bảng vẫn render (dùng +---+/|).
    assert.match(stripped, /\+-+\+/);
  });

  it("NO_COLOR=1 → không có SGR color sequence", () => {
    const out = renderInChild({ NO_COLOR: "1", FORCE_COLOR: undefined });
    // SGR color: ESC[...m — NO_COLOR phải tắt hết (chalk tôn trọng NO_COLOR).
    const sgr = out.match(/\x1b\[[0-9;]*m/g) ?? [];
    assert.deepEqual(sgr, [], `còn SGR sequences: ${sgr.slice(0, 5).join(" ")}`);
  });
});
