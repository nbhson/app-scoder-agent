/**
 * Unit tests cho TUI state reducer (dist/tui/state.js) + slash-command parser
 * (dist/tui/commands.js) — các phần thuần logic của `scoder tui`, không render.
 * Chạy: node --test test/tui-state.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, initialState, markAborted } from "../dist/tui/state.js";
import { parseSlashCommand, formatSlashHelp, SLASH_COMMANDS, completeMcpArg } from "../dist/tui/commands.js";

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

describe("tui state — phase breadcrumb + guardrail tracking", () => {
  it("toolPhase: map đúng tool → phase", async () => {
    const { toolPhase } = await import("../dist/tui/state.js");
    assert.equal(toolPhase("write_todos"), "plan");
    assert.equal(toolPhase("read_file"), "explore");
    assert.equal(toolPhase("list_files"), "explore");
    assert.equal(toolPhase("web_fetch"), "explore");
    assert.equal(toolPhase("load_skill"), "explore");
    assert.equal(toolPhase("write_file"), "edit");
    assert.equal(toolPhase("edit_file"), "edit");
    assert.equal(toolPhase("run_command"), "build");
    assert.equal(toolPhase("grep"), "explore");
    assert.equal(toolPhase("glob"), "explore");
    assert.equal(toolPhase("task"), "delegate");
    assert.equal(toolPhase("mcp__x__y"), "mcp");
  });

  it("run_start reset phases + guardrail; tool_call/build đẩy phase không trùng liền trước", async () => {
    const { toolPhase } = await import("../dist/tui/state.js");
    let s = initialState();
    s = applyEvent(s, { type: "run_start", task: "t", model: "m", provider: "p", workdir: "/w", buildCmd: "b", permission: "auto" });
    assert.deepEqual(s.phases, []);
    assert.equal(s.guardrailCount, 0);
    assert.equal(s.lastGuardrail, null);
    s = applyEvent(s, { type: "tool_call", step: 1, id: "1", name: "read_file", args: {} });
    s = applyEvent(s, { type: "tool_call", step: 1, id: "2", name: "read_file", args: {} });
    assert.deepEqual(s.phases, ["explore"], "trùng phase liền trước không đẩy lại");
    s = applyEvent(s, { type: "tool_call", step: 2, id: "3", name: "edit_file", args: {} });
    assert.deepEqual(s.phases, ["explore", "edit"]);
    s = applyEvent(s, { type: "tool_call", step: 3, id: "4", name: "run_command", args: {} });
    assert.deepEqual(s.phases, ["explore", "edit", "build"]);
    s = applyEvent(s, { type: "build", success: true, command: "b", output: "" });
    assert.deepEqual(s.phases, ["explore", "edit", "build", "verify"]);
  });

  it("guardrail event: đếm + giữ message thân thiện gần nhất (tự fit độ rộng bởi header)", async () => {
    let s = initialState();
    s = applyEvent(s, { type: "guardrail", rule: "doom-loop", action: "inject", reason: "x".repeat(80) });
    assert.equal(s.guardrailCount, 1);
    // Rule có trong bảng HUMAN → thông điệp tiếng Việt tự giải thích, không dump raw reason.
    assert.equal(s.lastGuardrail, "lặp lẫn lộn cùng tool call — yêu cầu đổi hướng");
    s = applyEvent(s, { type: "guardrail", rule: "unknown-rule", action: "inject", reason: "y".repeat(80) });
    assert.equal(s.guardrailCount, 2);
    // Rule lạ → fallback "rule: reason"; header tự fit (chrome) thay vì cắt cứng ở state.
    assert.ok(s.lastGuardrail.startsWith("unknown-rule: "));
    assert.ok(s.lastGuardrail.includes("y".repeat(80)), "không còn cắt cứng 72 ký tự trong state");
  });
});

// ── completeMcpArg (/mcp Tab completion) ────────────────────────────────────

describe("completeMcpArg", () => {
  const servers = [
    { name: "github", tools: [{ name: "get_me" }, { name: "get_tag" }] },
    { name: "filesystem", tools: [{ name: "read_file" }] },
  ];

  it("đang gõ tên server -> hoàn thành", () => {
    assert.equal(completeMcpArg("/mcp git", servers), "/mcp github ");
    assert.equal(completeMcpArg("/mcp f", servers), "/mcp filesystem ");
  });
  it("nhiều server khớp -> common prefix", () => {
    const two = [{ name: "alpha", tools: [] }, { name: "alphabet", tools: [] }];
    assert.equal(completeMcpArg("/mcp al", two), "/mcp alpha");
  });
  it("server + tool -> hoàn thành tool", () => {
    assert.equal(completeMcpArg("/mcp github get_m", servers), "/mcp github get_me ");
  });
  it("tool đang gõ kèm prefix mcp__ -> vẫn khớp", () => {
    assert.equal(completeMcpArg("/mcp github mcp__github__get_t", servers), "/mcp github get_tag ");
  });
  it("không khớp -> null", () => {
    assert.equal(completeMcpArg("/mcp zzz", servers), null);
    assert.equal(completeMcpArg("/mcp nerver tool", servers), null);
  });
});
