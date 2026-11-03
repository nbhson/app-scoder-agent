/**
 * T6: tool progress per-call — callId correlation (parallel calls) + live elapsed.
 * Chạy: node --test test/tui-progress.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, initialState } from "../dist/tui/state.js";

const base = { type: "run_start", task: "t", model: "m", provider: "p", workdir: "/tmp", buildCmd: "true", permission: "auto" };

describe("T6 — parallel tool cards correlate theo callId", () => {
  it("3 tool song song cùng tên → 3 card, mỗi result đúng card của nó", () => {
    const s = applyEvent(initialState(), base);
    applyEvent(s, { type: "tool_call", step: 1, id: "a", name: "read_file", args: { path: "a.ts" } });
    applyEvent(s, { type: "tool_call", step: 1, id: "b", name: "read_file", args: { path: "b.ts" } });
    applyEvent(s, { type: "tool_call", step: 1, id: "c", name: "read_file", args: { path: "c.ts" } });
    const tools = s.items.filter((i) => i.kind === "tool");
    assert.equal(tools.length, 3);
    assert.ok(tools.every((t) => t.ok === null), "3 card running đồng thời");

    // result "b" về trước "a" — phải đúng card (theo callId, không phải name).
    applyEvent(s, { type: "tool_result", step: 1, id: "b", name: "read_file", ok: true, output: "B-done" });
    applyEvent(s, { type: "tool_result", step: 1, id: "a", name: "read_file", ok: true, output: "A-done" });
    const byCall = Object.fromEntries(s.items.filter((i) => i.kind === "tool").map((t) => [t.callId, t]));
    assert.equal(byCall.a.ok, true);
    assert.equal(byCall.a.output, "A-done");
    assert.equal(byCall.b.ok, true);
    assert.equal(byCall.b.output, "B-done");
    assert.equal(byCall.c.ok, null, "c vẫn running");
  });

  it("tool_output gắn đúng card running (name-match, subagent tag)", () => {
    const s = applyEvent(initialState(), base);
    applyEvent(s, { type: "tool_call", step: 1, id: "x", name: "run_command", args: {} });
    applyEvent(s, { type: "tool_output", name: "run_command", stream: "stdout", delta: "chunk1" });
    const tool = s.items.find((i) => i.kind === "tool");
    assert.equal(tool.output, "chunk1");
    assert.ok(tool.startedAt > 0, "startedAt cho live elapsed");
    assert.equal(tool.durationMs, undefined, "chưa xong → live elapsed tính từ startedAt");
  });

  it("durationMs set khi result về", () => {
    const s = applyEvent(initialState(), base);
    applyEvent(s, { type: "tool_call", step: 1, id: "x", name: "run_command", args: {} });
    applyEvent(s, { type: "tool_result", step: 1, id: "x", name: "run_command", ok: true, output: "ok" });
    const tool = s.items.find((i) => i.kind === "tool");
    assert.equal(tool.ok, true);
    assert.ok(typeof tool.durationMs === "number");
  });
});
