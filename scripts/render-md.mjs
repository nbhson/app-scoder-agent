#!/usr/bin/env node
/**
 * Render một markdown fixture (hoặc file bất kỳ) qua <Markdown> của TUI và in
 * kết quả đã strip ANSI ra stdout — dùng để soi layout bằng mắt và làm input
 * cho snapshot test.
 *
 * Chạy:  npm run build && node scripts/render-md.mjs <file.md> [width]
 * Ví dụ: node scripts/render-md.mjs test/fixtures/markdown/table-unicode.md 60
 */
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { Markdown } from "../dist/tui/markdown.js";

const [file, widthArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/render-md.mjs <file.md> [width]");
  process.exit(2);
}
const width = Number(widthArg) || 80;
const text = readFileSync(file, "utf8");

const stream = new PassThrough();
stream.columns = width + 8; // pane thường hẹp hơn terminal một chút
stream.rows = 200;
let out = "";
stream.on("data", (c) => (out += String(c)));

const app = render(React.createElement(Markdown, { text, width }), {
  stdout: stream,
  stderr: stream,
  patchConsole: false,
  exitOnCtrlC: false,
});
await new Promise((r) => setTimeout(r, 120));
app.unmount();
await app.waitUntilExit();

const stripped = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
console.log(`─── width=${width} ${file} ${"─".repeat(Math.max(0, width - 14 - file.length))}`);
console.log(stripped.replace(/\n{3,}/g, "\n\n").trimEnd());
