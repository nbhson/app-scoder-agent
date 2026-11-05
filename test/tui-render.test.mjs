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
import { parseChartSpec, parseTimelineSpec, Markdown } from "../dist/tui/markdown.js";
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
  it("gauge: maxSteps=0 → null; scale 12 cells", () => {
    assert.equal(fuelGauge(0, 0), null);
    assert.equal(fuelGauge(4, 40).length, 12);
    assert.match(fuelGauge(4, 40), /^▰{1}▱{11}$/);
    assert.equal(fuelGauge(40, 40), "▰".repeat(12));
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
  it("wide: 1 hàng scoder | breadcrumb · [perm] · build lamp; KHÔNG model/gauge/step", async () => {
    const s = runningState();
    const out = await renderOnce(React.createElement(BuildRail, { state: s, config }), 120);
    assert.match(out, /scoder/);
    assert.match(out, /\[auto\]/);
    assert.match(out, /○ —/);
    assert.ok(!out.includes("m1"), "wide mode không hiện model (trùng bottom StatusBar)");
    assert.ok(!out.includes("▰"), "wide mode không hiện fuel gauge (trùng sidebar METRICS)");
    assert.ok(!/\d+\/40/.test(out), "step count không còn trên header (sidebar + StatusBar đã hiển thị)");
  });

  it("narrow: breadcrumb fallback khi sidebar ẩn; vẫn không có step count", async () => {
    const s = runningState();
    applyEvent(s, { type: "step", step: 1, maxSteps: 40 });
    applyEvent(s, { type: "tool_call", step: 1, id: "t1", name: "read_file", args: { path: "a.ts" } });
    const out = await renderOnce(React.createElement(BuildRail, { state: s, config }), 70);
    assert.ok(out.includes("plan ·"), "narrow hiện phase trail");
    assert.ok(!out.includes("▰"), "header không còn fuel gauge");
    assert.ok(!/\d+\/40/.test(out), "step count không còn trên header");
  });

  it("header không còn metrics row (tok/s, ctx, elapsed đã chuyển sidebar)", async () => {
    const s = runningState();
    applyEvent(s, { type: "step", step: 2, maxSteps: 40 });
    applyEvent(s, { type: "llm_usage", usage: { input_tokens: 1200, output_tokens: 340, cached_tokens: 0 } });
    const out = await renderOnce(React.createElement(BuildRail, { state: s, config }), 70);
    assert.ok(!out.includes("tok "), "tok/s không còn ở header");
    assert.ok(!out.includes("ctx "), "ctx không còn ở header");
  });

  it("guardrail notice render ở header (căn giữa) — không bị cắt khi còn chỗ", async () => {
    const s = runningState();
    applyEvent(s, { type: "guardrail", rule: "continue-nudge", action: "inject", reason: "plain text answer without tool calls (no files modified)" });
    const header = await renderOnce(React.createElement(BuildRail, { state: s, config }), 120);
    assert.match(header, /trả lời text chưa dùng tool — nhắc tiếp tục/);
    assert.ok(!header.includes("…"), "đủ chỗ thì không được truncate");
    const sidebar = await renderOnce(React.createElement(Sidebar, { state: s, config }), 120);
    assert.ok(!sidebar.includes("⚠"), "sidebar không còn guardrail notice ở cuối");
  });

  it("build lamp ok/fail đổi màu nhãn theo state", async () => {
    const s = runningState();
    applyEvent(s, { type: "build", success: true, command: "npm run build" });
    const okOut = await renderOnce(React.createElement(BuildRail, { state: s, config }), 120);
    assert.match(okOut, /✓ ok/);
    applyEvent(s, { type: "build", success: false, command: "npm run build" });
    const failOut = await renderOnce(React.createElement(BuildRail, { state: s, config }), 120);
    assert.match(failOut, /✗ fail/);
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
    assert.match(out, /ctx \d+k\/\d+k \(\d+%\)/);
    assert.match(out, /\$/);
    assert.match(out, /● fs/);
    assert.match(out, /◐ gate/);
    assert.match(out, /reconnecting/);
    assert.match(out, /● build fail/);
    assert.ok(!out.includes("⚠"), "guardrail notice đã chuyển lên header");
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
    assert.ok(SIDEBAR_WIDTH >= 34, "sidebar rộng hơn bản cũ 30 một chút");
    assert.ok(SIDEBAR_MIN_COLS >= 80);
  });
});

// ── ChatItemView: todo không còn render trong chat (chuyển sidebar) ──────────

describe("tui chat-views — todo chuyển sidebar", () => {
  it("user message: full border + bold text + you ▸ label — nổi bật hơn agent", async () => {
    const out = await renderOnce(
      React.createElement(ChatItemView, { item: { kind: "user", text: "fix the bug" } }),
      100,
    );
    assert.match(out, /you ▸/);
    assert.match(out, /fix the bug/);
    // Full border visible — "│" appears as left/right border chars after stripAnsi
    assert.ok(out.includes("│"), "user message có border đầy đủ (│ left/right border)");
  });

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

describe("tui rich display — chart/timeline/width", () => {
  it("parses chart JSON and line-oriented chart data", () => {
    assert.deepEqual(parseChartSpec('{"type":"line","data":[{"label":"Jan","value":4}]}'), {
      type: "line", data: [{ label: "Jan", value: 4 }],
    });
    assert.deepEqual(parseChartSpec("Alpha | 10\nBeta | 20", "chart:bar")?.data, [
      { label: "Alpha", value: 10 }, { label: "Beta", value: 20 },
    ]);
  });

  it("parses timeline JSON and pipe rows", () => {
    assert.deepEqual(parseTimelineSpec("2026-01-01 | Started | setup | done"), [
      { time: "2026-01-01", title: "Started", detail: "setup", status: "done" },
    ]);
    assert.equal(parseTimelineSpec('[{"time":"10:00","title":"Deploy","status":"active"}]')[0].title, "Deploy");
  });

  it("renders chart and timeline fences without overflowing a narrow pane", async () => {
    const out = await renderOnce(React.createElement(Markdown, {
      width: 42,
      text: [
        "```chart:bar",
        "Alpha | 10",
        "Beta | 20",
        "```",
        "```timeline",
        "10:00 | Deploy | production | active",
        "```",
      ].join("\n"),
    }), 50);
    assert.match(out, /chart/);
    assert.match(out, /Deploy/);
    assert.ok(out.split("\n").every((line) => line.length <= 50), "rich blocks stay within terminal width");
  });
});

// ── StatusBar ────────────────────────────────────────────────────────────────

describe("tui chrome — StatusBar", () => {
  it("idle: hiện keybinds, không spinner", async () => {
    const out = await renderOnce(React.createElement(StatusBar, { state: initialState(), scroll: null }), 120);
    assert.match(out, /idle/);
    assert.match(out, /ctrl\+c/);
  });

  it("running + scroll: hiện scroll position", async () => {
    const s = runningState();
    const out = await renderOnce(React.createElement(StatusBar, { state: s, scroll: "↑ 12/40" }), 120);
    assert.match(out, /running/);
    assert.match(out, /scroll ↑ 12\/40/);
  });
});
