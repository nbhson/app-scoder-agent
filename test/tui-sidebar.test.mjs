/**
 * Sidebar TUI (pattern opencode) — các phần thuần logic, không render:
 *   · reducer mcp_status structured (server/state) → map mcpServers cho sidebar
 *   · latestPlan(items) — plan mới nhất (last-wins) cho PlanSection
 * Chạy: node --test test/tui-sidebar.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, initialState, latestPlan } from "../dist/tui/state.js";

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
});
