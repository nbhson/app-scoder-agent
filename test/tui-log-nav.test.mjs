/**
 * P8 — Harness Log view-model helpers (src/tui/log.ts) + Sidebar LOG tab.
 *
 * Pure tests for filter buckets, tail windowing, cursor anchoring and lazy
 * payload resolution (transcript item → session .jsonl fallback), then one
 * Ink render proving the tab paints rows/DETAIL without touching OVERVIEW.
 * Chạy: node --test test/tui-log-nav.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render, Box } from "ink";
import { applyEvent, initialState } from "../dist/tui/state.js";
import { Sidebar } from "../dist/tui/sidebar.js";
import {
  filterLog,
  logWindow,
  moveSelection,
  followOffset,
  fmtLogTs,
  fmtLogClock,
  renderLog,
  detailMeta,
  logDetailLines,
  logGlyph,
  logSuffix,
  resolveLogPayload,
  payloadFromSessionLog,
  LOG_FILTER_CYCLE,
} from "../dist/tui/log.js";
import { clipCells, measure } from "../dist/tui/text-width.js";

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const E = (id, cat, text, meta = undefined, ref = undefined) => ({ id, ts: Date.UTC(2026, 0, 2, 9, 3, 4, 500), cat, text, meta, ref });

// ── filterLog buckets ───────────────────────────────────────────────────────

describe("log filter", () => {
  const entries = [
    E(1, "run", "r"), E(2, "llm", "l"), E(3, "tool", "t"), E(4, "shell", "s"),
    E(5, "file", "f"), E(6, "build", "b"), E(7, "mcp", "m"), E(8, "sub", "u"),
    E(9, "guard", "g"), E(10, "perm", "p"), E(11, "evt", "y"),
  ];
  it("ALL passes everything; buckets group by category", () => {
    assert.equal(filterLog(entries, "ALL").length, 11);
    assert.deepEqual(filterLog(entries, "LLM").map((e) => e.cat), ["llm"]);
    assert.deepEqual(filterLog(entries, "TOOL").map((e) => e.cat), ["tool", "shell", "file", "build"]);
    assert.deepEqual(filterLog(entries, "MCP").map((e) => e.cat), ["mcp"]);
    assert.deepEqual(filterLog(entries, "SUB").map((e) => e.cat), ["sub"]);
    assert.deepEqual(filterLog(entries, "EVT").map((e) => e.cat), ["run", "guard", "perm", "evt"]);
  });
  it("cycle list contains ALL first and never repeats", () => {
    assert.equal(LOG_FILTER_CYCLE[0], "ALL");
    assert.equal(new Set(LOG_FILTER_CYCLE).size, LOG_FILTER_CYCLE.length);
  });
});

// ── tail window ─────────────────────────────────────────────────────────────

describe("log window", () => {
  const entries = Array.from({ length: 100 }, (_, i) => E(i, "evt", `row ${i}`));
  it("offset 0 follows the tail; offset counts rows hidden at the BOTTOM", () => {
    const w = logWindow(entries, 10, 0);
    assert.equal(w.rows.at(-1).text, "row 99");
    assert.equal(w.rows[0].text, "row 90");
    assert.equal(w.first, 90);
    const back = logWindow(entries, 10, 5);
    assert.equal(back.rows.at(-1).text, "row 94");
    assert.equal(back.maxOffset, 90);
  });
  it("clamps overscroll and short tails", () => {
    assert.equal(logWindow(entries, 10, 1000).rows[0].text, "row 0");
    assert.equal(logWindow(entries.slice(0, 4), 10, 0).rows.length, 4);
    assert.equal(logWindow(entries.slice(0, 4), 10, 0).maxOffset, 0);
  });
});

// ── selection anchors ───────────────────────────────────────────────────────

describe("selection", () => {
  const ids = [10, 11, 12, 13];
  it("starts at the newest, moves by delta, clamps at the ends", () => {
    assert.equal(moveSelection(ids, null, -1), 12);
    assert.equal(moveSelection(ids, 12, -1), 11);
    assert.equal(moveSelection(ids, 11, 1), 12);
    assert.equal(moveSelection(ids, 10, -1), 10);
    assert.equal(moveSelection(ids, 13, 1), 13);
    assert.equal(moveSelection([], 3, -1), null);
  });
  it("survives eviction of the anchored entry (clamps to nearest end)", () => {
    assert.equal(moveSelection([30, 31, 32], 5, -1), 30);
    assert.equal(moveSelection([30, 31, 32], 99, 1), 32);
  });
  it("followOffset keeps the cursor inside the window", () => {
    const entries = Array.from({ length: 100 }, (_, i) => E(i, "evt", `r${i}`));
    assert.equal(followOffset(entries, 10, 0, 95), 0, "visible already");
    assert.equal(followOffset(entries, 10, 0, 50), 40, "window scrolls up until the row is on screen");
    assert.equal(followOffset(entries, 10, 45, 99), 0, "moving below the window snaps to tail");
    assert.equal(followOffset(entries, 10, 90, null), 90, "no selection = untouched");
  });
});

// ── formatting helpers ──────────────────────────────────────────────────────

describe("formatting", () => {
  it("fmtLogTs = fixed HH:MM:SS.d column", () => {
    assert.match(fmtLogTs(Date.UTC(2026, 0, 2, 9, 3, 4, 500)), /^\d{2}:\d{2}:\d{2}\.\d$/);
  });
  it("fmtLogClock = compact sidebar clock (no tenths)", () => {
    const ts = new Date(2026, 0, 2, 9, 3, 4, 500).getTime(); // local — matches fmtLogClock
    assert.equal(fmtLogClock(ts), "09:03:04");
  });
  it("detailMeta spells out every counter", () => {
    const m = detailMeta(E(1, "llm", "x", { tokensIn: 10, tokensOut: 20, cached: 5, ms: 1234, chunks: 3, bytes: 400, count: 2, exit: true, pct: 30 }));
    for (const bit of ["in 10 out 20 cache 5", "1.2s", "3 chunks", "400 bytes", "2 ticks", "exit 0", "30% ctx"]) {
      assert.ok(m.includes(bit), `missing ${bit}`);
    }
  });
  it("live rows get a … suffix, closed rows don't", () => {
    assert.equal(logSuffix(E(1, "llm", "x", { live: true, chunks: 4, bytes: 1500 })), " … 4c 1.5kB");
    assert.equal(logSuffix(E(1, "tool", "x", { live: false })), "");
  });
  it("folded events surface a ×N counter — the audit trail stays complete", () => {
    assert.equal(logSuffix(E(1, "evt", "ctx 40%", { key: "ctx", hits: 7 })), " · ×7");
    assert.equal(logSuffix(E(1, "evt", "ctx 40%", { key: "ctx", hits: 1 })), "");
  });
  it("renderLog paints a fixed kind column then the message", () => {
    assert.equal(renderLog(E(1, "shell", "npm test → ok", { ms: 50 }), 40), "SHELL npm test → ok");
    assert.equal(renderLog(E(2, "evt", "ctx 34%", { key: "ctx", hits: 3 }), 40), "EVT   ctx 34% · ×3");
    assert.ok(renderLog(E(3, "tool", "x".repeat(300), {}), 30).length <= 36, "clipped to width + column");
  });
  it("glyphs are one display cell in both charsets", () => {
    for (const cat of ["run", "llm", "tool", "shell", "file", "build", "mcp", "sub", "guard", "perm", "evt"]) {
      const g = logGlyph(cat);
      assert.ok(measure(g) <= 2, `${cat} glyph ${g} too wide`);
    }
  });
  it("DETAIL panel is ≤ 8 cell-clipped lines", () => {
    const lines = logDetailLines(E(7, "tool", "x".repeat(400), { live: false, ms: 500 }, { kind: "item", step: 3, callId: "call-abc-123456789", name: "run_command" }), 44, clipCells);
    assert.ok(lines.length <= 8);
    for (const l of lines) assert.ok(measure(l) <= 44, `over 44 cells: ${l}`);
  });
});

// ── payload resolution ──────────────────────────────────────────────────────

describe("payload resolution", () => {
  const items = [
    { kind: "tool", name: "run_command", args: { command: "ls -la" }, callId: "c1", ok: true, output: "file list…", step: 2 },
    { kind: "tool", name: "run_command", args: { command: "npm test" }, callId: "c2", ok: false, output: "FAIL", step: 2 },
    { kind: "diff", path: "src/a.ts", text: "@@ -1 +1 @@\n-x\n+y", added: 1, removed: 1, truncated: false, step: 3 },
  ];
  it("tool rows resolve by callId (not the same-name sibling)", () => {
    const p = resolveLogPayload(E(1, "shell", "▸ npm test", {}, { kind: "item", step: 2, callId: "c2", name: "run_command" }), items);
    assert.match(p.text, /npm test/);
    assert.match(p.text, /FAIL/);
    assert.equal(p.meta, "FAILED");
  });
  it("file rows resolve to the stored diff", () => {
    const p = resolveLogPayload(E(2, "file", "+1 -1 src/a.ts", {}, { kind: "item", step: 3 }), items);
    assert.equal(p.kind, "diff");
    assert.match(p.text, /\+y/);
  });
  it("rows without a ref fall back to their own text + counters", () => {
    const p = resolveLogPayload(E(3, "evt", "compact 90.0k→12.0k", { ms: 800 }), items);
    assert.match(p.text, /compact 90\.0k→12\.0k/);
    assert.match(p.text, /0\.8s/);
  });
  it("evicted tool payloads resolve from the session jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "scoder-log-"));
    mkdirSync(join(dir, ".scoder", "logs"), { recursive: true });
    writeFileSync(
      join(dir, ".scoder", "logs", "s1.jsonl"),
      [
        JSON.stringify({ ts: "x", type: "tool_call", step: 2, id: "c9", name: "run_command", args: {} }),
        JSON.stringify({ ts: "x", type: "tool_result", step: 2, id: "c9", name: "run_command", ok: false, output: "the big evicted output" }),
      ].join("\n") + "\n",
    );
    assert.equal(payloadFromSessionLog(dir, "s1", "c9", "run_command"), "the big evicted output");
    assert.equal(payloadFromSessionLog(dir, "s1", "nope", "run_command"), null);
    assert.equal(payloadFromSessionLog(dir, "missing-session", "c9", "run_command"), null);
    const p = resolveLogPayload(E(4, "shell", "▸ gone", {}, { kind: "item", step: 2, callId: "c9", name: "run_command" }), [], { workdir: dir, sessionId: "s1" });
    assert.match(p.text, /the big evicted output/);
    assert.match(p.title, /from session log/);
  });
});

// ── Sidebar LOG tab render ──────────────────────────────────────────────────

const cfg = { workdir: "/tmp/x", model: "m1", provider: "openai", permissionMode: "auto", limits: {} };

async function renderSidebar(state, rows, tab, view) {
  const stream = new PassThrough();
  stream.columns = 100;
  stream.rows = Math.max(rows, 24);
  let out = "";
  stream.on("data", (c) => (out += String(c)));
  const app = render(
    React.createElement(Box, { flexDirection: "row", height: rows },
      React.createElement(Box, { flexGrow: 1 }, React.createElement("ink-text", null, "chat")),
      React.createElement(Sidebar, { state, config: cfg, rows, tab, view })),
    { stdout: stream, stderr: stream, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise((r) => setTimeout(r, 80));
  app.unmount();
  await app.waitUntilExit();
  return stripAnsi(out);
}

function buildLogState() {
  const s = initialState();
  applyEvent(s, { type: "run_start", task: "demo", model: "m1", provider: "openai", workdir: "/tmp/x", buildCmd: "npm run build" });
  applyEvent(s, { type: "step", step: 1, maxSteps: 9 });
  applyEvent(s, { type: "llm_delta", delta: "hi" });
  applyEvent(s, { type: "llm_usage", usage: { input_tokens: 100, output_tokens: 20 } });
  applyEvent(s, { type: "tool_call", step: 1, id: "c1", name: "run_command", args: { command: "echo hi" } });
  applyEvent(s, { type: "tool_output", name: "run_command", stream: "stdout", delta: "hi" });
  applyEvent(s, { type: "tool_result", step: 1, id: "c1", name: "run_command", ok: true, output: "hi" });
  return s;
}

describe("sidebar — harness log tab", () => {
  it("paints the tab bar, rows with time+glyph columns and the key hints", async () => {
    const out = await renderSidebar(buildLogState(), 30, "log", { filter: "ALL", selId: null, offset: 0, detail: false });
    assert.match(out, /HARNESS LOG/);
    assert.match(out, /│/);
    assert.match(out, /step 1\/9/);
    assert.match(out, /#1 m1/);
    assert.match(out, /echo hi → ok/);
    assert.match(out, /\d{2}:\d{2}:\d{2}/);
    assert.match(out, /jk select/);
  });

  it("filter pill narrows rows; selection marks the cursor", async () => {
    const out = await renderSidebar(buildLogState(), 30, "log", { filter: "TOOL", selId: 3, offset: 0, detail: false });
    assert.match(out, /· TOOL/);
    assert.match(out, /echo hi → ok/);
    assert.ok(!out.includes("step 1/9"), "run rows hidden under TOOL");
    assert.match(out, /❱/, "selected row marker");
  });

  it("DETAIL panel renders meta + ref below the list", async () => {
    const out = await renderSidebar(buildLogState(), 30, "log", { filter: "ALL", selId: 3, offset: 0, detail: true });
    assert.match(out, /DETAIL/);
    assert.match(out, /ref step 1/);
    assert.match(out, /Enter full/);
  });

  it("empty log shows the hint line, not a blank pane", async () => {
    const out = await renderSidebar(initialState(), 30, "log", { filter: "ALL", selId: null, offset: 0, detail: false });
    assert.match(out, /nothing yet/);
  });

  it("OVERVIEW keeps every section plus the new tab bar", async () => {
    const s = buildLogState();
    applyEvent(s, { type: "build", success: true, command: "npm run build", output: "" });
    const out = await renderSidebar(s, 40, "overview", { filter: "ALL", selId: null, offset: 0, detail: false });
    for (const section of ["SESSION", "METRICS", "BUILD"]) assert.ok(out.includes(`─ ${section}`), `missing ${section}`);
    assert.match(out, /OVERVIEW/);
  });
});
