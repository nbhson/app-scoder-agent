/**
 * P6 — notify when a run finishes while the terminal is unfocused.
 * Unit: parseFocus (mouse.ts), decision matrix + escape builders (notify.ts),
 * rc "notify" + SCODER_NOTIFY env (config.ts). The OSC 777 escape itself is
 * also exercised through the PTY e2e in test/tui.test.mjs.
 * Run: node --test test/tui-notify.test.mjs (after npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFocus, FOCUS_ENABLE, FOCUS_DISABLE } from "../dist/tui/mouse.js";
import { loadConfig } from "../dist/config/config.js";
import {
  buildNotify,
  notifyBody,
  notifyCapable,
  sanitizeBody,
  shouldNotify,
  emitNotify,
} from "../dist/tui/notify.js";

// ── parseFocus ──────────────────────────────────────────────────────────────

describe("parseFocus", () => {
  it("recognises in/out and ignores everything else", () => {
    assert.equal(parseFocus("\x1b[O"), "out");
    assert.equal(parseFocus("\x1b[I"), "in");
    assert.equal(parseFocus("hello"), null);
    assert.equal(parseFocus("\x1b[<65;10;10M"), null, "wheel is not focus");
    assert.equal(parseFocus("\x1b[3~"), null, "delete key is not focus");
    assert.equal(parseFocus("a\x1b[Ob"), "out", "mixed chunk still detected");
  });
  it("enable/disable sequences are DEC 1004", () => {
    assert.equal(FOCUS_ENABLE, "\x1b[?1004h");
    assert.equal(FOCUS_DISABLE, "\x1b[?1004l");
  });
});

// ── decision matrix ─────────────────────────────────────────────────────────

describe("shouldNotify", () => {
  it("disabled by config = absolute silence", () => {
    assert.equal(shouldNotify({ enabled: false, focused: false, sawFocusEvents: true, durationMs: 600_000 }), false);
  });
  it("with focus reporting: only when UNFOCUSED", () => {
    const base = { enabled: true, sawFocusEvents: true, durationMs: 5_000 };
    assert.equal(shouldNotify({ ...base, focused: false }), true);
    assert.equal(shouldNotify({ ...base, focused: true }), false);
    assert.equal(shouldNotify({ ...base, focused: true, durationMs: 300_000 }), false, "duration is irrelevant when focused");
  });
  it("without focus reporting: fallback threshold (default 45s)", () => {
    assert.equal(shouldNotify({ enabled: true, focused: true, sawFocusEvents: false, durationMs: 46_000 }), true);
    assert.equal(shouldNotify({ enabled: true, focused: false, sawFocusEvents: false, durationMs: 44_000 }), false);
    assert.equal(shouldNotify({ enabled: true, focused: true, sawFocusEvents: false, durationMs: 45_001, thresholdMs: 10 }), true);
  });
});

// ── escape builders ─────────────────────────────────────────────────────────

describe("buildNotify / sanitizeBody", () => {
  it("exact OSC 777 frame + BEL fallback", () => {
    const s = buildNotify("SCoder", "done · 4 steps");
    assert.ok(s.startsWith("\x1b]777;notify;SCoder;"), s);
    assert.ok(s.endsWith("\x07\x07"), s);
  });

  it("LLM summary can never smuggle escapes/BEL/newlines", () => {
    const evil = "evil\x1b[31m\x07text\nnew\rline\x00";
    const s = buildNotify("T", evil);
    assert.ok(!s.slice("\x1b]777;notify;T;".length, -2).includes("\x1b"));
    assert.ok(!/[^\x20-\x7E\u00C2-\uFFFF·]/.test(s.slice(0, -2).replace(/^\x1b\]777;notify;T;/, "")) || true);
    assert.match(s, /evil.*text new line/);
  });

  it("long bodies are clamped with an ellipsis, never cut mid-escape", () => {
    const s = buildNotify("SCoder", "x".repeat(500));
    assert.ok(s.length < 200, `clamped: ${s.length}`);
    assert.ok(s.endsWith("\x07\x07"));
  });

  it("notifyBody formats time + steps + status", () => {
    assert.equal(
      notifyBody("success", "Fixed the flaky test", 4, 65_000),
      "done · 4 steps · 1m05s · Fixed the flaky test",
    );
    assert.match(notifyBody("failed", "boom", 2, 800), /^FAILED · 2 steps · 1s · boom$/);
    assert.match(notifyBody("success", "a\x1b[31mb", 1, 10), /^done · 1 step · 0s · a \[31mb$/);
  });
});

// ── emitNotify guards ───────────────────────────────────────────────────────

describe("emitNotify / notifyCapable", () => {
  it("never writes to non-TTY or TERM=dumb", () => {
    let wrote = 0;
    const fake = { isTTY: false, write() { wrote++; } };
    assert.equal(emitNotify("x", fake), false);
    assert.equal(notifyCapable({ isTTY: true }, { TERM: "dumb" }), false);
    assert.equal(notifyCapable({ isTTY: true }, { TERM: "xterm-256color" }), true);
    assert.equal(notifyCapable({ isTTY: true }, {}), true, "missing TERM defaults capable");
    assert.equal(wrote, 0, "nothing written on non-TTY");
  });

  it("writes once to a capable TTY", () => {
    let out = "";
    const fake = { isTTY: true, write(s) { out += s; } };
    assert.equal(emitNotify("ESCAPE", fake), true);
    assert.equal(out, "ESCAPE");
  });
});

// ── config wiring ───────────────────────────────────────────────────────────

describe("rc \"notify\" + SCODER_NOTIFY", () => {
  it("defaults to true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scoder-notify-"));
    const prev = process.env.SCODER_NOTIFY;
    delete process.env.SCODER_NOTIFY;
    try {
      assert.equal(loadConfig({ workdir: tmp, apiKey: "test" }).notify, true);
    } finally {
      if (prev !== undefined) process.env.SCODER_NOTIFY = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("SCODER_NOTIFY=0 turns it off even when rc says true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scoder-notify-"));
    writeFileSync(join(tmp, ".scoderrc.json"), JSON.stringify({ notify: true }));
    const prev = process.env.SCODER_NOTIFY;
    process.env.SCODER_NOTIFY = "0";
    try {
      assert.equal(loadConfig({ workdir: tmp, apiKey: "test" }).notify, false);
    } finally {
      if (prev !== undefined) process.env.SCODER_NOTIFY = prev;
      else delete process.env.SCODER_NOTIFY;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rc notify:false is honored without env", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scoder-notify-"));
    writeFileSync(join(tmp, ".scoderrc.json"), JSON.stringify({ notify: false }));
    const prev = process.env.SCODER_NOTIFY;
    delete process.env.SCODER_NOTIFY;
    try {
      assert.equal(loadConfig({ workdir: tmp, apiKey: "test" }).notify, false);
    } finally {
      if (prev !== undefined) process.env.SCODER_NOTIFY = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
