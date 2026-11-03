/**
 * Render tests cho chrome (BuildRail/StatusBar) + Sidebar + ChatItemView.
 * Ink render với stdout giả (PassThrough) — không cần TTY, chạy trong unit
 * test: bảo đảm cả 2 chế độ header (wide có sidebar / narrow fallback) và
 * các section sidebar render đúng nội dung theo state.
 * Chạy: node --test test/tui-render.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { BuildRail, StatusBar, fuelGauge, gaugeColor, SIDEBAR_MIN_COLS, SIDEBAR_WIDTH } from "../dist/tui/chrome.js";
import { Sidebar } from "../dist/tui/sidebar.js";
import { ChatItemView } from "../dist/tui/chat-views.js";
import { applyEvent, initialState, latestPlan } from "../dist/tui/state.js";

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** Render một element vào stdout giả, trả về output đã strip ANSI. */
async function renderOnce(element, columns = 100) {
  const stream = new PassThrough();
  stream.columns = columns;
  stream.rows = 30;
  let out = "";
  stream.on("data", (c) => (out += String(c)));
  const app = render(element, { stdout: stream, stderr: stream, patchConsole: false, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 80));
  app.unmount();
  await app.waitUntilExit();
  return stripAnsi(out);
}

const config = {
  workdir: "/tmp/demo-proj",
  model: "test-model",
  provider: "openai",
  permissionMode: "auto",
  mcpServers: { fs: { command: "node fs-server.js" }, gate: { command: "node gate.js" } },
  buildCmd: "npm run build",
};

/** State sau run_start (running) + tiện ích phủ nhanh các nhánh reducer. */
function runningState() {
  return applyEvent(initialState(), {
    type: "run_start",
    task: "fix it",
    model: "m1",
    provider: "openai",
    workdir: "/tmp/demo-proj",
    buildCmd: "npm run build",
  });
}

// ── fuelGauge / gaugeColor (pure) ────────────────────────────────────────────

describe("tui chrome — fuelGauge/gaugeColor", () => {
  it("gauge: maxSteps=0 → null; scale 10 cells", () => {
    assert.equal(fuelGauge(0, 0), null);
    assert.equal(fuelGauge(4, 40).length, 10);
    assert.match(fuelGauge(4, 40), /^▰{1}▱{9}$/);
    assert.equal(fuelGauge(40, 40), "▰".repeat(10));
  });

  it("gaugeColor: headroom green → warn → red", () => {
    assert.equal(gaugeColor(1, 40), "green");
    assert.equal(gaugeColor(32, 40), "yellow"); // 0.8
    assert.equal(gaugeColor(35, 40), "red"); // 0.875 ≥ 0.85
    assert.equal(gaugeColor(3, 0), "green"); // maxSteps=0 → ratio 0
  });
});

// ── BuildRail: wide (sidebar) vs narrow (fallback) ───────────────────────────

describe("tui chrome — BuildRail wide/narrow", () => {
  it("wide: 1 hàng scoder·model | ⛨ perm | lamp | gauge; KHÔNG breadcrumb/metrics", async () => {
    const s = runningState();
    const out = await renderOnce(React.createElement(BuildRail, { state: s, config }), 120);
    assert.match(out, /scoder · m1/);
    assert.match(out, /⛨ auto/);
    assert.match(out, /● no build yet/);
    assert.match(out, /— idle/); // chưa có step → idle gauge
    assert.ok(!out.includes("› "), "wide mode không render breadcrumb (chuyển sang sidebar)");
    assert.ok(!out.includes("starting…"), "wide mode không render metrics row");
  });

  it("narrow: giữ hàng phụ breadcrumb + metrics (fallback khi sidebar ẩn)", async () => {
    const s = runningState();
    applyEvent(s, { type: "step", step: 1, maxSteps: 40 });
    applyEvent(s, { type: "tool_call", step: 1, id: "t1", name: "read_file", args: { path: "a.ts" } });
    const out = await renderOnce(React.createElement(BuildRail, { state: s, config }), 70);
    assert.match(out, /plan › explore › edit › build › verify/);
    assert.match(out, /0:00/); // startedAt đã set (run_start) → metrics row = elapsed
    // gauge có step
    assert.match(out, /1\/40/);
  });

  it("running + usage: metrics row có tok/s + elapsed", async () => {
    const s = runningState();
    applyEvent(s, { type: "step", step: 2, maxSteps: 40 });
    applyEvent(s, { type: "llm_usage", usage: { input_tokens: 1200, output_tokens: 340, cached_tokens: 0 } });
    const out = await renderOnce(React.createElement(BuildRail, { state: s, config }), 70);
    assert.match(out, /tok 1\.2k→340/);
    assert.match(out, /ctx 1%/); // 1200 tokens so với context window
  });

  it("build lamp ok/fail đổi màu nhãn theo state", async () => {
    const s = runningState();
    applyEvent(s, { type: "build", success: true, command: "npm run build" });
    const okOut = await renderOnce(React.createElement(BuildRail, { state: s, config }), 120);
    assert.match(okOut, /● build ok/);
    applyEvent(s, { type: "build", success: false, command: "npm run build" });
    const failOut = await renderOnce(React.createElement(BuildRail, { state: s, config }), 120);
    assert.match(failOut, /● build fail/);
  });
});

// ── Sidebar: sections theo state ─────────────────────────────────────────────

describe("tui sidebar — render sections", () => {
  it("idle mới vào: các section rỗng hiển thị placeholder", async () => {
    const out = await renderOnce(React.createElement(Sidebar, { state: initialState(), config }), 120);
    assert.match(out, /SESSION/);
    assert.match(out, /no plan yet/);
    assert.match(out, /— idle/); // phases
    assert.match(out, /no build yet/);
    assert.ok(!out.includes("none configured"), "config CÓ mcpServers → không hiện 'none configured'");
    assert.match(out, /waiting/); // server chưa connect
    assert.match(out, /fs/);
  });

  it("run có plan + usage + mcp states + guardrail", async () => {
    const s = runningState();
    s.model = "gpt-4o"; // có trong catalog → ctx% + cost có số liệu
    applyEvent(s, {
      type: "todo",
      items: [
        { content: "read lib.js", status: "completed" },
        { content: "fix add()", status: "in_progress" },
        { content: "run build", status: "pending" },
      ],
    });
    applyEvent(s, { type: "step", step: 3, maxSteps: 40 });
    applyEvent(s, { type: "llm_usage", usage: { input_tokens: 1500, output_tokens: 700, cached_tokens: 200 } });
    applyEvent(s, { type: "mcp_status", line: "l", server: "fs", state: "ready" });
    applyEvent(s, { type: "mcp_status", line: "l", server: "gate", state: "reconnecting" });
    applyEvent(s, { type: "build", success: false, command: "npm run build" });
    applyEvent(s, { type: "guardrail", rule: "completion-claim", action: "inject", reason: "bắt build" });
    await new Promise((r) => setTimeout(r, 600)); // elapsed > 0.5s → tok/s hiện
    const out = await renderOnce(React.createElement(Sidebar, { state: s, config }), 120);
    assert.match(out, /1\/3 steps/);
    assert.match(out, /✔ read lib\.js/);
    assert.match(out, /◆ fix add\(\)/);
    assert.match(out, /○ run build/);
    assert.match(out, /1\.5k → 700/);
    assert.match(out, /tok\/s/);
    assert.match(out, /ctx \d+%/);
    assert.match(out, /\$/);
    assert.match(out, /● fs/);
    assert.match(out, /◐ gate/);
    assert.match(out, /reconnecting/);
    assert.match(out, /● build fail/);
    assert.match(out, /⚠/); // guardrail notice
  });

  it("config không có mcpServers → 'none configured'", async () => {
    const out = await renderOnce(
      React.createElement(Sidebar, { state: initialState(), config: { ...config, mcpServers: {} } }),
      120,
    );
    assert.match(out, /none configured/);
  });

  it("SIDEBAR_WIDTH/MIN_COLS export đúng kiểu", () => {
    assert.equal(typeof SIDEBAR_WIDTH, "number");
    assert.ok(SIDEBAR_MIN_COLS >= 80);
  });
});

// ── ChatItemView: todo không còn render trong chat (chuyển sidebar) ──────────

describe("tui chat-views — todo chuyển sidebar", () => {
  it("todo item render rỗng (null) trong chat", async () => {
    const out = await renderOnce(
      React.createElement(ChatItemView, { item: { kind: "todo", items: [{ content: "a", status: "pending" }] } }),
      100,
    );
    assert.equal(out.trim(), "");
  });

  it("latestPlan là nguồn dữ liệu sidebar: last-wins", () => {
    const plan = latestPlan([
      { kind: "todo", items: [{ content: "old", status: "pending" }] },
      { kind: "todo", items: [{ content: "new", status: "in_progress" }] },
    ]);
    assert.equal(plan.items[0].content, "new");
  });
});

// ── StatusBar ────────────────────────────────────────────────────────────────

describe("tui chrome — StatusBar", () => {
  it("idle: hiện keybinds, không spinner", async () => {
    const out = await renderOnce(React.createElement(StatusBar, { state: initialState(), scroll: null }), 120);
    assert.match(out, /idle/);
    assert.match(out, /ctrl\+c quit/);
  });

  it("running + scroll: hiện scrollback position", async () => {
    const s = runningState();
    const out = await renderOnce(React.createElement(StatusBar, { state: s, scroll: "↑ 12/40" }), 120);
    assert.match(out, /running/);
    assert.match(out, /scrollback/);
  });
});
