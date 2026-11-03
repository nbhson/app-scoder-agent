/**
 * T1: unit tests cho command-registry — dispatch dùng chung REPL/TUI.
 * Chạy: node --test test/command-registry.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchCommand,
  coreCommands,
  formatUsage,
  formatSkills,
  formatSessions,
  formatMcpStatus,
} from "../dist/tui/command-registry.js";

/** Fake host — agent chỉ cần các method /cost /skills /permission đụng tới. */
/** @typedef {import("../dist/tui/command-registry.js").CommandHost} CommandHost */
/** @typedef {import("../dist/tui/command-registry.js").NoticeSink} NoticeSink */

function fakeHost(over = {}) {
  return {
    agent: () => null,
    config: { workdir: "/tmp/x", permissionMode: "auto" },
    replaceAgent: () => {},
    ...over,
  };
}

/** Notice collector. */
function sink() {
  const lines = [];
  return { lines, fn: (text, level = "info") => lines.push({ text, level }) };
}

describe("dispatchCommand (T1)", () => {
  it("input thường → handled:false (frontend gửi LLM)", async () => {
    const s = sink();
    const r = await dispatchCommand("fix the bug", fakeHost(), s.fn);
    assert.equal(r.handled, false);
    assert.equal(r.outcome, null);
    assert.equal(s.lines.length, 0);
  });

  it("/help → notice listing, handled", async () => {
    const s = sink();
    const r = await dispatchCommand("/help", fakeHost(), s.fn);
    assert.equal(r.handled, true);
    assert.match(s.lines[0].text, /Commands/);
    assert.match(s.lines[0].text, /\/cost/);
  });

  it("/exit + /quit → outcome.quit (không notice)", async () => {
    const s = sink();
    const r = await dispatchCommand("/quit", fakeHost(), s.fn);
    assert.equal(r.handled, true);
    assert.equal(r.outcome?.quit, true);
    assert.equal(s.lines.length, 0);
  });

  it("không phải slash → handled:false", async () => {
    const r = await dispatchCommand("hello world", fakeHost(), sink().fn);
    assert.equal(r.handled, false);
  });

  it("command lạ → error notice", async () => {
    const s = sink();
    const r = await dispatchCommand("/nonexistent", fakeHost(), s.fn);
    assert.equal(r.handled, true);
    assert.equal(s.lines[0].level, "error");
    assert.match(s.lines[0].text, /unknown command/);
  });

  it("/skill thiếu arg → usage warn", async () => {
    const s = sink();
    await dispatchCommand("/skill", fakeHost(), s.fn);
    assert.equal(s.lines[0].level, "warn");
    assert.match(s.lines[0].text, /usage: \/skill/);
  });

  it("handler ném lỗi → bắt thành error notice (không crash dispatcher)", async () => {
    const s = sink();
    const host = fakeHost({
      agent: () => {
        throw new Error("boom from agent");
      },
    });
    const r = await dispatchCommand("/cost", host, s.fn);
    assert.equal(r.handled, true);
    assert.equal(s.lines[0].level, "error");
    assert.match(s.lines[0].text, /boom from agent/);
  });

  it("agent null → /cost fallback zero usage", async () => {
    const s = sink();
    await dispatchCommand("/cost", fakeHost(), s.fn);
    assert.match(s.lines[0].text, /no LLM calls yet/);
  });

  it("extra command được nhận trước core (frontend-specific override)", async () => {
    const s = sink();
    const r = await dispatchCommand("/cost", fakeHost(), s.fn, [
      { name: "/cost", description: "override", run: () => ({ notice: "OVERRIDE" }) },
    ]);
    assert.equal(r.handled, true);
    assert.equal(r.outcome?.notice, "OVERRIDE");
    assert.equal(s.lines.length, 0);
  });

  it("coreCommands: mỗi entry có name bắt đầu / + description", () => {
    for (const c of coreCommands()) {
      assert.ok(c.name.startsWith("/"));
      assert.ok(c.description.length > 0);
      assert.equal(typeof c.run, "function");
    }
    assert.ok(coreCommands().some((c) => c.name === "/mcp"));
    assert.ok(coreCommands().some((c) => c.name === "/sessions"));
  });
});

describe("formatters (T1)", () => {
  it("formatUsage: zero + có cached", () => {
    assert.match(formatUsage({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), /no LLM calls yet/);
    assert.match(
      formatUsage({ calls: 2, inputTokens: 100, outputTokens: 50, cachedTokens: 10 }),
      /2 LLM calls.*in 100 \/ out 50.*\+10 cached/s,
    );
  });
  it("formatSkills: rỗng + có skill", () => {
    assert.match(formatSkills([]), /no skills discovered/);
    assert.match(formatSkills([{ name: "rev", description: "review code", path: "/p", scope: "project", body: "" }]), /rev\s+review code\s+\[project\]/);
  });
  it("formatSessions: rỗng + có session", () => {
    assert.match(formatSessions([]), /no saved sessions/);
    const t = formatSessions([{ id: "abcdefgh-1234", task: "fix bug", steps: 3, updatedAt: "2026-01-01T10:00:00Z" }]);
    assert.match(t, /abcdefgh/);
    assert.match(t, /fix bug/);
  });
  it("formatMcpStatus: rỗng + server không kết nối + tool", () => {
    assert.match(formatMcpStatus([]), /no MCP servers configured/);
    const t = formatMcpStatus([{ name: "srv", command: "node x.js", connected: false, tools: [] }]);
    assert.match(t, /· srv — node x\.js \(not connected\)/);
    const t2 = formatMcpStatus([{ name: "srv", command: "c", connected: true, tools: [{ name: "t1", description: "d" }] }]);
    assert.match(t2, /✓ srv/);
    assert.match(t2, /mcp__srv__t1\s+d/);
  });
});
