/**
 * Phase 7 — TUI transcript helpers: export, search, copyTextForItem.
 * Chạy: node --test test/transcript.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  exportTranscript,
  findInTranscript,
  copyTextForItem,
  itemToText,
  itemToMarkdown,
} from "../dist/tui/transcript.js";

/** Minimal chat item factory — no TS annotations (pure .mjs). */
function item(kind, extra = {}) {
  return Object.assign({ kind }, extra);
}

describe("exportTranscript", () => {
  it("md: renders each kind correctly", () => {
    const items = [
      item("user", { text: "hello" }),
      item("assistant", { text: "hi there" }),
      item("tool", { name: "read_file", args: { path: "a.ts" }, output: "content", ok: true, step: 1, durationMs: 100 }),
      item("diff", { path: "b.ts", text: "+c", added: 1, removed: 0, step: 1 }),
      item("build", { success: true, command: "npm build" }),
      item("compaction", { tokensBefore: 1000, tokensAfter: 200 }),
    ];
    const md = exportTranscript(items, "md");
    assert.ok(md.includes("## you"), "has user");
    assert.ok(md.includes("## agent"), "has assistant");
    assert.ok(md.includes("read_file"), "has tool");
    assert.ok(md.includes("b.ts"), "has diff path");
    assert.ok(md.includes("npm build"), "has build");
    assert.ok(md.includes("compacted"), "has compaction");
  });

  it("json: returns valid JSON array", () => {
    const items = [item("user", { text: "hello" })];
    const j = exportTranscript(items, "json");
    const parsed = JSON.parse(j);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].kind, "user");
  });

  it("empty items → empty output", () => {
    assert.equal(exportTranscript([], "md"), "");
    assert.equal(exportTranscript([], "json"), "[]");
  });
});

describe("findInTranscript", () => {
  it("finds keyword in assistant text", () => {
    const items = [item("assistant", { text: "the authentication module needs a fix" })];
    const results = findInTranscript(items, "auth");
    assert.equal(results.length, 1);
    assert.ok(results[0].snippet.includes("auth"));
  });

  it("finds keyword in tool name + output", () => {
    const items = [item("tool", { name: "read_file", output: "import { auth } from './auth'", step: 1 })];
    const results = findInTranscript(items, "auth");
    assert.equal(results.length, 1);
  });

  it("finds keyword in diff path", () => {
    const items = [item("diff", { path: "src/auth/login.ts", text: "+token", added: 1, removed: 0, step: 1 })];
    const results = findInTranscript(items, "auth");
    assert.equal(results.length, 1);
    assert.ok(results[0].snippet.includes("auth"));
  });

  it("case-insensitive search", () => {
    const items = [item("assistant", { text: "TypeScript ERROR" })];
    assert.equal(findInTranscript(items, "typescript").length, 1);
    assert.equal(findInTranscript(items, "ERROR").length, 1);
    assert.equal(findInTranscript(items, "xyz123").length, 0);
  });

  it("returns empty for blank query", () => {
    assert.deepStrictEqual(findInTranscript([], ""), []);
    assert.deepStrictEqual(findInTranscript([], "  "), []);
  });

  it("returns multiple matches across items", () => {
    const items = [
      item("assistant", { text: "fix the error" }),
      item("tool", { name: "edit_file", output: "error: undefined", step: 1 }),
      item("notice", { text: "error resolved", level: "info" }),
    ];
    assert.equal(findInTranscript(items, "error").length, 3);
  });

  it("snippet truncates long text to ~130 chars", () => {
    const items = [item("assistant", { text: "a".repeat(200) + "TARGET" + "b".repeat(200) })];
    const results = findInTranscript(items, "TARGET");
    assert.ok(results[0].snippet.length <= 130, "snippet capped at ~130 chars");
    assert.ok(results[0].snippet.includes("TARGET"));
  });
});

describe("copyTextForItem", () => {
  it("diff → diff text", () => {
    const d = item("diff", { text: "--- a/x\n+++ b/x\n@@" });
    assert.match(copyTextForItem(d), /--- a\/x/);
  });
  it("tool → tool output", () => {
    const t = item("tool", { name: "x", output: "result", step: 1 });
    assert.equal(copyTextForItem(t), "result");
  });
  it("assistant → text", () => {
    const a = item("assistant", { text: "hello world" });
    assert.equal(copyTextForItem(a), "hello world");
  });
});

describe("itemToText / itemToMarkdown", () => {
  it("tool includes name + output", () => {
    const t = item("tool", { name: "grep", args: { path: "x.ts" }, output: "found", step: 1, ok: true });
    assert.ok(itemToText(t).includes("grep"));
    assert.ok(itemToMarkdown(t).includes("grep"));
  });
  it("diff shows path and stats", () => {
    const d = item("diff", { path: "x.ts", text: "+a", added: 1, removed: 0, step: 1 });
    assert.ok(itemToText(d).includes("x.ts"));
    assert.ok(itemToMarkdown(d).includes("x.ts"));
  });
});
