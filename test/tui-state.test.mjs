/**
 * Unit tests cho TUI state reducer (dist/tui/state.js) + slash-command parser
 * (dist/tui/commands.js) — các phần thuần logic của `scoder tui`, không render.
 * Chạy: node --test test/tui-state.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, initialState, markAborted } from "../dist/tui/state.js";
import { parseSlashCommand, formatSlashHelp, SLASH_COMMANDS } from "../dist/tui/commands.js";

const baseEvent = {
  type: "run_start",
  task: "fix the bug",
  model: "m1",
  provider: "openai",
  workdir: "/tmp/x",
  buildCmd: "npm run build",
};

// ── Reducer: diff items ─────────────────────────────────────────────────────

describe("tui state — tool_result diff", () => {
  it("tool_result kèm diff tạo ra item kind=diff sau tool item", () => {
    const s = applyEvent(initialState(), baseEvent);
    applyEvent(s, { type: "step", step: 3, maxSteps: 40 });
    applyEvent(s, { type: "tool_call", step: 3, id: "t1", name: "edit_file", args: { path: "a.ts" } });
    applyEvent(s, {
      type: "tool_result",
      step: 3,
      name: "edit_file",
      ok: true,
      output: "Edited a.ts",
      diff: { path: "a.ts", text: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new", added: 1, removed: 1, truncated: false },
    });

    const kinds = s.items.map((i) => i.kind);
    assert.deepEqual(kinds, ["user", "tool", "diff"]);
    const diff = s.items[2];
    assert.equal(diff.path, "a.ts");
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert.equal(diff.step, 3);
    assert.match(diff.text, /\+new/);
  });

  it("tool_result không diff (run_command) không tạo item diff", () => {
    const s = applyEvent(initialState(), baseEvent);
    applyEvent(s, { type: "tool_call", step: 1, id: "t1", name: "run_command", args: {} });
    applyEvent(s, { type: "tool_result", step: 1, name: "run_command", ok: true, output: "ok" });
    assert.ok(s.items.every((i) => i.kind !== "diff"));
  });
});

// ── Reducer: build lamp ─────────────────────────────────────────────────────

describe("tui state — build lamp", () => {
  it("build event cập nhật buildLamp ok/fail", () => {
    const s = applyEvent(initialState(), baseEvent);
    assert.equal(s.buildLamp, "none");
    applyEvent(s, { type: "build", success: false, command: "npm run build", output: "" });
    assert.equal(s.buildLamp, "fail");
    applyEvent(s, { type: "build", success: true, command: "npm run build", output: "" });
    assert.equal(s.buildLamp, "ok");
  });

  it("run_start mới reset buildLamp về none", () => {
    const s = applyEvent(initialState(), baseEvent);
    applyEvent(s, { type: "build", success: true, command: "x", output: "" });
    applyEvent(s, { ...baseEvent, task: "task 2" });
    assert.equal(s.buildLamp, "none");
  });
});

// ── Reducer: abort ──────────────────────────────────────────────────────────

describe("tui state — markAborted", () => {
  it("đóng assistant đang streaming và đặt status aborted", () => {
    const s = applyEvent(initialState(), baseEvent);
    applyEvent(s, { type: "llm_delta", delta: "working…" });
    markAborted(s);
    assert.equal(s.status, "aborted");
    const last = s.items[s.items.length - 1];
    assert.equal(last.streaming, false);
  });
});

// ── Slash-command parser ────────────────────────────────────────────────────

describe("parseSlashCommand", () => {
  it("nhận diện /cmd và tách arg", () => {
    assert.deepEqual(parseSlashCommand("/help"), { cmd: "/help", arg: "" });
    assert.deepEqual(parseSlashCommand("/cost"), { cmd: "/cost", arg: "" });
    assert.deepEqual(parseSlashCommand("  /clear  "), { cmd: "/clear", arg: "" });
    assert.deepEqual(parseSlashCommand("/exit now"), { cmd: "/exit", arg: "now" });
  });

  it("chữ hoa được chuẩn hóa về chữ thường", () => {
    assert.deepEqual(parseSlashCommand("/HELP"), { cmd: "/help", arg: "" });
  });

  it("trả về null cho input thường và chuỗi rỗng", () => {
    assert.equal(parseSlashCommand("fix the bug"), null);
    assert.equal(parseSlashCommand("/"), null);
    assert.equal(parseSlashCommand("path/like"), null);
    assert.equal(parseSlashCommand(""), null);
  });

  it("không nhận số làm ký tự đầu", () => {
    assert.equal(parseSlashCommand("/123"), null);
  });
});

describe("formatSlashHelp", () => {
  it("liệt kê đủ các lệnh và nhãn frontend", () => {
    const text = formatSlashHelp("scoder tui");
    for (const c of SLASH_COMMANDS) assert.ok(text.includes(c.cmd), `thiếu ${c.cmd}`);
    assert.ok(text.includes("scoder tui"));
  });
});
