/**
 * Render tests cho SessionPicker (Ctrl+S) — popup "improve TUI" phải trải hết
 * chiều ngang terminal như Palette — không clip ở 38 cell — và không bao giờ
 * cao quá rows.
 * Chạy: node --test test/tui-popup-width.test.mjs (sau npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import { SessionPicker } from "../dist/tui/session-picker.js";

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** Render 1 lần với TTY giả (stdin stub cho useInput) — trả về dòng đã strip. */
async function renderLines(element, columns = 100, rows = 30) {
  const stream = new PassThrough();
  stream.columns = columns;
  stream.rows = rows;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.setEncoding = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  stdin.on = () => stdin;
  stdin.removeListener = () => stdin;
  let out = "";
  stream.on("data", (c) => (out += String(c)));
  const app = render(element, { stdout: stream, stderr: stream, stdin, patchConsole: false, exitOnCtrlC: false });
  let stable = 0;
  let last = out;
  const t0 = Date.now();
  while (Date.now() - t0 < 3_000 && stable < 3) {
    await new Promise((r) => setTimeout(r, 15));
    if (out === last) stable++;
    else { stable = 0; last = out; }
  }
  app.unmount();
  await app.waitUntilExit();
  return stripAnsi(out).replace(/\n+$/, "").split("\n");
}

// ── SessionPicker fixtures ────────────────────────────────────────────────────

function sessionFixtures(count) {
  const dir = mkdtempSync(join(tmpdir(), "scoder-picker-"));
  const sdir = join(dir, ".scoder", "sessions");
  mkdirSync(sdir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `2026112${i}-1030${i}1-session${i}`;
    mkdirSync(join(sdir, id), { recursive: true });
    writeFileSync(join(sdir, id, "manifest.json"), JSON.stringify({
      id,
      task: `session ${i}: refactor the authentication middleware and add refresh-token rotation with sliding expiry windows`,
      steps: i * 3,
      updatedAt: `2026-11-${String(10 + (i % 15)).padStart(2, "0")}T10:30:00Z`,
    }));
  }
  return dir;
}

const noop = () => {};

describe("SessionPicker — fullwidth + height cap (improve TUI)", () => {
  it("trải hết chiều ngang terminal rộng (border = cols)", async () => {
    const lines = await renderLines(
      React.createElement(SessionPicker, { workdir: sessionFixtures(6), onSelect: noop, onClose: noop }),
      140, 30,
    );
    assert.equal(lines[0].length, 140, "border trên phải dài đúng số cột");
    assert.ok(lines.some((l) => l.startsWith("│ ─") && l.length === 140), "divider ngang full width");
  });

  it("hàng session gọn 1 dòng, đủ cột id/date/steps/task khi rộng", async () => {
    const lines = await renderLines(
      React.createElement(SessionPicker, { workdir: sessionFixtures(4), onSelect: noop, onClose: noop }),
      140, 30,
    );
    const sel = lines.find((l) => l.includes("▸"));
    assert.ok(sel, "có dòng selection ▸");
    // id + date + steps + task cùng nằm trên MỘT dòng (không wrap 2 dòng)
    assert.match(sel, /20261123-1030/);
    assert.match(sel, /2026-11-/);
    assert.match(sel, /steps/);
    assert.match(sel, /session 3: refactor/);
  });

  it("không cao quá rows: cửa sổ self-limit trên terminal thấp", async () => {
    const lines = await renderLines(
      React.createElement(SessionPicker, { workdir: sessionFixtures(14), onSelect: noop, onClose: noop }),
      80, 20,
    );
    assert.ok(lines.length <= 20, `picker tràn terminal: ${lines.length} dòng > 20`);
    assert.ok(lines.some((l) => l.includes("+") && l.includes("more")), "có chỉ báo ⋯ +N more");
    assert.ok(lines.every((l) => l.length <= 80), "không dòng nào rộng quá cols");
  });

  it("terminal hẹp vẫn nằm gọn trong cols (degrade, không vỡ layout)", async () => {
    const lines = await renderLines(
      React.createElement(SessionPicker, { workdir: sessionFixtures(5), onSelect: noop, onClose: noop }),
      50, 30,
    );
    assert.equal(lines[0].length, 50);
    assert.ok(lines.every((l) => l.length <= 50), `dài nhất=${Math.max(...lines.map((l) => l.length))}`);
  });
});
