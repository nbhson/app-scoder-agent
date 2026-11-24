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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import { BuildRail, StatusBar, fuelGauge, gaugeColor, SIDEBAR_MIN_COLS, SIDEBAR_WIDTH } from "../dist/tui/chrome.js";
import { Sidebar } from "../dist/tui/sidebar.js";
import { ChatItemView } from "../dist/tui/chat-views.js";
import { charset } from "../dist/tui/charset.js";
import { parseChartSpec, parseTimelineSpec, Markdown, DiagramFocusContext } from "../dist/tui/markdown.js";
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
  // Ink paint bất đồng bộ: fixed 80ms là nguồn flaky trên CI chậm (frame tới
  // muộn) và lãng phí trên máy nhanh. Poll tới khi output ổn định (3 mẫu
  // liên tiếp không đổi), cap 3s.
  {
    let stable = 0;
    let last = out;
    const t0 = Date.now();
    while (Date.now() - t0 < 3_000 && stable < 3) {
      await new Promise((r) => setTimeout(r, 15));
      if (out === last) stable++;
      else { stable = 0; last = out; }
    }
  }
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
    assert.match(out, /scoder \(v\d+\.\d+\.\d+\)/);
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

  // ── P-stream: markdown live trong lúc generate (không còn raw text) ──────

  it("streaming assistant: markdown collapse khoảng trắng dư + ▋ inline", async () => {
    const item = { kind: "assistant", text: "Working on it.\n\n\n\nI will check the file.", streaming: true };
    const out = await renderOnce(React.createElement(ChatItemView, { item }), 100);
    assert.ok(out.includes("Working on it."), "content live");
    assert.ok(out.includes("I will check the file.▋"), "cursor trails last text inline");
    const lines = out.split("\n");
    const wi = lines.findIndex((l) => l.includes("Working on it."));
    let blanks = 0;
    for (let k = wi + 1; k < lines.length && lines[k].trim() === ""; k++) blanks++;
    assert.ok(blanks <= 1, `paragraph break = at most one blank row; raw source showed 3 (got ${blanks})`);
  });

  it("streaming assistant rỗng: chỉ cursor, không crash", async () => {
    const out = await renderOnce(
      React.createElement(ChatItemView, { item: { kind: "assistant", text: "", streaming: true } }),
      100,
    );
    assert.match(out, /▋/);
  });

  it("streaming code fence đang mở: giữ nguyên dòng code, không nhảy dạng", async () => {
    const out = await renderOnce(
      React.createElement(
        ChatItemView,
        { item: { kind: "assistant", text: "Here:\n\n```js\nconst x = 1;\ncons", streaming: true } },
        100,
      ),
    );
    assert.match(out, /const x = 1;/);
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

  // ── P2.3: diagram focus ───────────────────────────────────────────────────

  it("chart focus parses (focus/active alias) and marks exactly one row", async () => {
    assert.equal(parseChartSpec('{"data":[{"label":"A","value":1}],"focus":"A"}')?.focus, "A");
    assert.equal(parseChartSpec('{"data":[{"label":"A","value":1}],"active":"A"}')?.focus, "A");
    assert.equal(parseChartSpec('{"data":[{"label":"A","value":1}]}')?.focus, undefined);
    const out = await renderOnce(React.createElement(Markdown, {
      width: 42,
      text: [
        "```chart:bar",
        '{"title":"t","focus":"Beta","data":[{"label":"Alpha","value":10},{"label":"Beta","value":20}]}',
        "```",
      ].join("\n"),
    }), 50);
    const lines = out.split("\n");
    assert.equal(out.split(charset.active).length - 1, 1, "exactly one focus marker on screen");
    assert.ok(lines.some((l) => l.includes("Beta") && l.includes(charset.active)), "marker sits on the focused row");
    assert.ok(lines.some((l) => l.includes("Alpha") && !l.includes(charset.active)), "other rows keep the plain marker");
  });

  it("mermaid :::focus directive renders layered; export slug ignores focus moves", async () => {
    const real = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "scoder-focus-"));
    try {
      process.chdir(tmp);
      const out = await renderOnce(React.createElement(Markdown, {
        width: 60,
        text: ["```mermaid", "flowchart LR", "  A[Start]:::focus --> B[End]", "```"].join("\n"),
      }), 70);
      assert.match(out, /focus: A/);
      assert.match(out, /┌/, "still a real box-drawing graph");
      assert.ok(!out.includes(":::focus"), "class token never leaks into the drawing");
      const dir = join(tmp, ".scoder", "diagrams");
      assert.equal(readdirSync(dir).length, 1, "closed fence exports its source once");
      assert.match(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"), /flowchart LR/);
      // Same diagram re-printed with the focus on another node: the directive
      // is presentation-only, so it must NOT duplicate the export file.
      await renderOnce(React.createElement(Markdown, {
        width: 60,
        text: ["```mermaid", "flowchart LR", "  A[Start] --> B[End]:::focus", "```"].join("\n"),
      }), 70);
      assert.equal(readdirSync(dir).length, 1, "moved focus reuses the same slug");
    } finally {
      process.chdir(real);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("diagram_focus event highlights a printed diagram through context (and only the matching one)", async () => {
    const real = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "scoder-evt-"));
    const fence = (a, b) => ["```mermaid", "flowchart LR", `  A[${a}] --> B[${b}]`, "```"].join("\n");
    const twoDiagrams = React.createElement(Markdown, {
      width: 60,
      text: [fence("One", "Two"), fence("Red", "Blue")].join("\n\n"),
    });
    const wrap = (value) => React.createElement(DiagramFocusContext.Provider, { value }, twoDiagrams);
    try {
      process.chdir(tmp);
      const plain = await renderOnce(wrap(null), 70);
      assert.ok(!plain.includes("focus:"), "no event, no focus");
      const evt = { diagram: "One", node: "B", prev: "A", ts: Date.now() };
      const hit = await renderOnce(wrap(evt), 70);
      assert.equal((hit.match(/focus: Two/g) ?? []).length, 1, "exactly the hinted block lights up");
      const miss = await renderOnce(wrap({ ...evt, diagram: "Nope" }), 70);
      assert.ok(!miss.includes("focus:"), "a diagram hint absent from both blocks matches nothing");
      const byLabel = await renderOnce(wrap({ diagram: "", node: "blue", prev: null, ts: Date.now() }), 70);
      assert.match(byLabel, /focus: Blue/, "labels resolve case-insensitively");
    } finally {
      process.chdir(real);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── StatusBar ────────────────────────────────────────────────────────────────

describe("tui chrome — StatusBar", () => {
  it("idle: hiện keybinds, không spinner", async () => {
    const out = await renderOnce(React.createElement(StatusBar, { state: initialState(), scroll: null }), 120);
    assert.match(out, /idle/);
    assert.match(out, /Ctrl\+C/);
  });

  it("key hints viết chữ (Ctrl+B, Enter) — không glyph ⌃ ⇧ ⏎ ⇥, không cắt giữa hint", async () => {
    const wide = await renderOnce(React.createElement(StatusBar, { state: initialState(), scroll: null }), 120);
    assert.ok(!/[⌃⇧⏎⇥⌥]/.test(wide), `footer không có glyph phím: ${JSON.stringify(wide)}`);
    assert.match(wide, /Enter send/);
    assert.match(wide, /Ctrl\+B router/); // P2.2: overview → router (Ctrl+B cycle 3 tab)
    // 100 cols: hint RƠI nguyên khối khỏi đuôi, không biến thành "Ctrl+C qu…"
    const narrow = await renderOnce(React.createElement(StatusBar, { state: initialState(), scroll: null }), 100);
    const hintRow = narrow.split("\n").find((l) => l.includes("Enter send")) ?? "";
    assert.ok(!hintRow.includes("…"), `hint không bị cắt giữa từ: ${JSON.stringify(hintRow)}`);
    assert.match(hintRow, /Ctrl\+C quit/);
  });

  it("running + scroll: hiện scroll position", async () => {
    const s = runningState();
    const out = await renderOnce(React.createElement(StatusBar, { state: s, scroll: "12/40 above" }), 120);
    assert.match(out, /running/);
    assert.match(out, /scroll 12\/40 above/);
  });
});

// ── Improve TUI: header/footer chiều cao cố định ở mọi resolution ───────────

describe("tui chrome — fixed height mọi width (improve TUI)", () => {
  it("BuildRail guardrail dài: đúng 2 hàng (1 content + 1 divider) từ 20 → 380 cols, không wrap dồn hàng", async () => {
    const s = runningState();
    applyEvent(s, {
      type: "guardrail",
      rule: "duplicate-action",
      action: "block",
      reason: "the agent repeated the exact same tool call four times in a row, which usually means it is stuck",
    });
    for (const cols of [20, 30, 40, 60, 100, 240, 380]) {
      const out = await renderOnce(React.createElement(BuildRail, { state: s, config }), cols);
      const lines = out.replace(/\n+$/, "").split("\n");
      assert.equal(lines.length, 2, `cols=${cols}: header phải đúng 2 hàng, nhận được ${JSON.stringify(lines)}`);
    }
  });

  it("BuildRail idle + git branch dài: vẫn 2 hàng khi terminal cực hẹp", async () => {
    const git = { branch: "feature/a-very-long-branch-name-that-never-fits-anywhere", dirty: 12 };
    for (const cols of [20, 40, 100]) {
      const out = await renderOnce(React.createElement(BuildRail, { state: initialState(), config, git }), cols);
      assert.equal(out.replace(/\n+$/, "").split("\n").length, 2, `cols=${cols}: header idle+git phải 2 hàng`);
    }
  });

  it("StatusBar running + model name siêu dài + scroll: đúng 2 hàng ở mọi width", async () => {
    const s = runningState();
    s.model = "claude-opus-4-5-very-long-model-name-for-testing-wrap-behavior";
    for (const cols of [20, 30, 40, 80, 120, 240, 380]) {
      const out = await renderOnce(React.createElement(StatusBar, { state: s, scroll: "12/40 above" }), cols);
      assert.equal(out.replace(/\n+$/, "").split("\n").length, 2, `cols=${cols}: footer phải đúng 2 hàng`);
    }
  });
});
