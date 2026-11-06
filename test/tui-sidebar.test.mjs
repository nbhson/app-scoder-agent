/**
 * Sidebar TUI (pattern opencode) — các phần thuần logic, không render:
 *   · reducer mcp_status structured (server/state) → map mcpServers cho sidebar
 *   · latestPlan(items) — plan mới nhất (last-wins) cho PlanSection
 *   · state.plan — field chuyên dụng cho sidebar (miễn nhiễm MAX_ITEMS eviction)
 *   · height budget — thứ tự section cố định (layout gốc) SESSION → MCP →
 *     METRICS → PHASES → PLAN → SUBAGENTS → BUILD; section không vừa trọn vẹn
 *     bị bỏ qua (không clip nửa chừng); PLAN co giãn theo chỗ còn lại
 * Chạy: node --test test/tui-sidebar.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import React from "react";
import { render, Box } from "ink";
import { applyEvent, initialState, latestPlan } from "../dist/tui/state.js";
import { Sidebar } from "../dist/tui/sidebar.js";

const baseEvent = {
  type: "run_start",
  task: "fix the bug",
  model: "m1",
  provider: "openai",
  workdir: "/tmp/x",
  buildCmd: "npm run build",
};

// ── Reducer: mcp_status structured (sidebar map) ─────────────────────────────

describe("tui sidebar — mcp_status structured", () => {
  it("event có server+state cập nhật map mcpServers, không append notice", () => {
    const s = applyEvent(initialState(), baseEvent);
    applyEvent(s, { type: "mcp_status", line: 'MCP "fs" ready — connected', server: "fs", state: "ready" });
    applyEvent(s, { type: "mcp_status", line: 'MCP "db" connecting — spawn', server: "db", state: "connecting" });
    assert.deepEqual(s.mcpServers, { fs: "ready", db: "connecting" });
    // Không spam chat: chỉ user item từ run_start.
    assert.equal(s.items.filter((i) => i.kind === "notice").length, 0);
  });

  it("transition reconnecting → ready → dead ghi đè theo server", () => {
    const s = applyEvent(initialState(), baseEvent);
    applyEvent(s, { type: "mcp_status", line: "l1", server: "fs", state: "connecting" });
    applyEvent(s, { type: "mcp_status", line: "l2", server: "fs", state: "reconnecting" });
    applyEvent(s, { type: "mcp_status", line: "l3", server: "fs", state: "ready" });
    assert.equal(s.mcpServers.fs, "ready");
    applyEvent(s, { type: "mcp_status", line: "l4", server: "fs", state: "dead" });
    assert.equal(s.mcpServers.fs, "dead");
  });

  it("event text thuần (không server/state) vẫn append notice như cũ", () => {
    const s = applyEvent(initialState(), baseEvent);
    applyEvent(s, { type: "mcp_status", line: '✓ MCP "fs" connected — 2 tools' });
    assert.deepEqual(s.mcpServers, {});
    const notices = s.items.filter((i) => i.kind === "notice");
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /connected/);
  });

  it("state mới (initialState) có map rỗng — không phá reducer cũ", () => {
    const s = initialState();
    assert.deepEqual(s.mcpServers, {});
  });
});

// ── latestPlan — nguồn dữ liệu PlanSection của sidebar ───────────────────────

describe("tui sidebar — latestPlan", () => {
  it("trả về null khi chưa có todo item nào", () => {
    assert.equal(latestPlan([]), null);
    const s = applyEvent(initialState(), baseEvent);
    assert.equal(latestPlan(s.items), null);
  });

  it("last-wins: todo update sau chiếm chỗ todo trước (sidebar chỉ cần snapshot)", () => {
    const items = [
      { kind: "todo", items: [{ content: "step 1", status: "completed" }] },
      { kind: "notice", text: "n", level: "info" },
      {
        kind: "todo",
        items: [
          { content: "step 1", status: "completed" },
          { content: "step 2", status: "in_progress" },
          { content: "step 3", status: "pending" },
        ],
      },
    ];
    const plan = latestPlan(items);
    assert.equal(plan.items.length, 3);
    assert.equal(plan.items[1].status, "in_progress");
  });

  it("reset realtime: user message mới xoá stale plan từ task trước", () => {
    // Plan A từ task trước, sau đó user gửi message mới → plan reset
    const items = [
      { kind: "user", text: "task 1" },
      { kind: "todo", items: [{ content: "old plan", status: "in_progress" }] },
      { kind: "user", text: "task 2 — new request" },
    ];
    assert.equal(latestPlan(items), null, "plan từ task trước reset khi user gửi message mới");
  });

  it("reset realtime: todo sau user message hiện bình thường (plan mới)", () => {
    const items = [
      { kind: "user", text: "task 1" },
      { kind: "todo", items: [{ content: "step 1", status: "completed" }] },
      { kind: "user", text: "task 2" },
      { kind: "todo", items: [{ content: "step A", status: "in_progress" }] },
    ];
    const plan = latestPlan(items);
    assert.ok(plan, "plan mới hiện sau user message mới");
    assert.equal(plan.items[0].content, "step A");
  });
});

// ── state.plan — nguồn dữ liệu PlanSection (không qua items, không bị evict) ──

describe("tui sidebar — state.plan field", () => {
  const planEvent = {
    type: "todo",
    items: [
      { content: "step 1", status: "completed" },
      { content: "step 2", status: "in_progress" },
    ],
  };

  it("todo event set state.plan (last-wins snapshot)", () => {
    const s = applyEvent(initialState(), baseEvent);
    assert.equal(s.plan, null);
    applyEvent(s, planEvent);
    assert.equal(s.plan.length, 2);
    applyEvent(s, { type: "todo", items: [{ content: "only", status: "in_progress" }] });
    assert.equal(s.plan.length, 1);
    assert.equal(s.plan[0].content, "only");
  });

  it("run_start reset plan (stale plan không lọt sang task mới)", () => {
    const s = applyEvent(initialState(), baseEvent);
    applyEvent(s, planEvent);
    assert.ok(s.plan);
    applyEvent(s, { ...baseEvent, task: "new task" });
    assert.equal(s.plan, null);
  });

  it("plan sống sót qua MAX_ITEMS eviction — regression 'tác vụ nặng mất plan'", () => {
    const s = applyEvent(initialState(), baseEvent);
    applyEvent(s, planEvent);
    // Run nặng: > 400 items (MAX_ITEMS) đẩy todo item ra khỏi transcript…
    for (let i = 0; i < 450; i++) {
      applyEvent(s, { type: "tool_call", id: `c${i}`, name: "read_file", args: {}, step: i });
    }
    assert.equal(latestPlan(s.items), null, "todo item đã bị evict khỏi items");
    assert.ok(s.plan, "state.plan vẫn giữ snapshot cho sidebar");
    assert.equal(s.plan[1].content, "step 2");
  });
});

// ── Height budget — thứ tự gốc cố định, section thừa bỏ qua gọn ─────────────

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

async function renderSidebar(state, cfg, rows, containerHeight = rows) {
  const stream = new PassThrough();
  stream.columns = 100;
  stream.rows = Math.max(containerHeight, 24);
  let out = "";
  stream.on("data", (c) => (out += String(c)));
  const app = render(
    React.createElement(
      Box,
      { flexDirection: "row", height: containerHeight },
      React.createElement(Box, { flexGrow: 1 }, React.createElement("ink-text", null, "chat")),
      React.createElement(Sidebar, { state, config: cfg, rows }),
    ),
    { stdout: stream, stderr: stream, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise((r) => setTimeout(r, 80));
  app.unmount();
  await app.waitUntilExit();
  return stripAnsi(out);
}

describe("tui sidebar — height budget (thứ tự gốc, fit gọn)", () => {
  const cfg = { workdir: "/tmp/demo", model: "gpt-4o", mcpServers: { fs: {}, gate: {} } };

  function busyState() {
    const s = applyEvent(initialState(), baseEvent);
    applyEvent(s, {
      type: "todo",
      items: [
        { content: "investigate root cause", status: "completed" },
        { content: "implement fix", status: "in_progress" },
        { content: "verify build", status: "pending" },
      ],
    });
    applyEvent(s, { type: "step", step: 3, maxSteps: 40 });
    applyEvent(s, { type: "llm_usage", usage: { input_tokens: 1500, output_tokens: 700, cached_tokens: 200 } });
    applyEvent(s, { type: "mcp_status", line: "l", server: "fs", state: "ready" });
    applyEvent(s, { type: "mcp_status", line: "l", server: "gate", state: "ready" });
    applyEvent(s, { type: "build", success: false, command: "npm run build" });
    return s;
  }

  it("thứ tự section đúng layout gốc: SESSION → MCP → METRICS → PHASES → PLAN → BUILD", async () => {
    const out = await renderSidebar(busyState(), cfg, undefined, 60);
    const order = ["─ SESSION", "─ MCP", "─ METRICS", "─ PHASES", "─ PLAN", "─ BUILD"];
    let prev = -1;
    for (const section of order) {
      const idx = out.indexOf(section);
      assert.ok(idx > prev, `section ${section} phải hiện và đứng sau section trước`);
      prev = idx;
    }
  });

  it("terminal thấp (~22 dòng): section dưới không vừa bị BỎ QUA trọn vẹn (không clip nửa chừng)", async () => {
    const out = await renderSidebar(busyState(), cfg, 22);
    // Vừa: SESSION + MCP + METRICS. Hết chỗ: PHASES + PLAN + BUILD.
    assert.match(out, /─ SESSION/);
    assert.match(out, /─ MCP/);
    assert.match(out, /─ METRICS/);
    assert.ok(!out.includes("─ PHASES"), "PHASES không vừa → bỏ qua, không render nửa section");
    assert.ok(!out.includes("─ PLAN"), "PLAN không vừa → bỏ qua, không render nửa section");
    assert.ok(!out.includes("─ BUILD"), "BUILD không vừa → bỏ qua, không render nửa section");
    assert.match(out, /└─/, "border dưới vẽ gọn");
  });

  it("terminal vừa (~31 dòng): PHASES hiện, PLAN co giãn theo chỗ còn lại", async () => {
    const out = await renderSidebar(busyState(), cfg, 31);
    assert.match(out, /─ PHASES/);
    assert.match(out, /─ PLAN/);
    assert.match(out, /1\/3 steps/);
    assert.match(out, /… \+2 more/, "plan bị cap theo chỗ còn lại");
  });

  it("không truyền rows → render đủ mọi section (back-compat cho terminal cao)", async () => {
    const out = await renderSidebar(busyState(), cfg, undefined, 60);
    for (const section of ["SESSION", "MCP", "METRICS", "PHASES", "PLAN", "BUILD"]) {
      assert.ok(out.includes(`─ ${section}`), `thiếu section ${section}`);
    }
  });

  it("plan dài bị cap theo chỗ còn lại, METRICS (đứng trước) không bị ảnh hưởng", async () => {
    const s = busyState();
    applyEvent(s, {
      type: "todo",
      items: Array.from({ length: 14 }, (_, i) => ({ content: `step ${i + 1}`, status: i === 0 ? "in_progress" : "pending" })),
    });
    const out = await renderSidebar(s, cfg, 31);
    assert.match(out, /─ METRICS/, "METRICS vẫn hiện dù plan dài");
    assert.match(out, /steps ▰/, "fuel gauge của METRICS vẫn vẽ");
    assert.match(out, /─ PLAN/);
    assert.match(out, /… \+13 more/, "plan bị cap khi thiếu chỗ");
    assert.ok(!out.includes("step 14"), "không vẽ tràn hết 14 dòng plan");
  });
});
