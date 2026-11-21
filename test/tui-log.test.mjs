/**
 * P8 — Harness Log reducer tests (state.ts applyEvent → state.log).
 *
 * Locks the two contracts the sidebar tab depends on:
 *   1. CATEGORY  — every meaningful harness activity lands exactly one row in
 *      the right bucket (run/llm/tool/shell/file/build/mcp/sub/guard/perm/sys).
 *   2. ANTI-SPAM — streaming events (llm_delta/reasoning, tool_output,
 *      tool_progress, warmup ticks, context per step) MERGE into the open row
 *      or are thresholded; they never flood the ring.
 * Plus ring-buffer eviction (MAX_LOG_ENTRIES / logDropped) and immutability.
 * Chạy: node --test test/tui-log.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, initialState, logNote, markAborted, MAX_LOG_ENTRIES } from "../dist/tui/state.js";

const runStart = {
  type: "run_start", task: "fix the flaky test", model: "m1", provider: "openai",
  workdir: "/tmp/x", buildCmd: "npm run build", agent: "build",
};
const cat = (s) => s.log.map((e) => e.cat);
const texts = (s) => s.log.map((e) => e.text);
const byCat = (s, c) => s.log.filter((e) => e.cat === c);

function fed(...events) {
  const s = initialState();
  applyEvent(s, runStart);
  for (const ev of events) applyEvent(s, ev);
  return s;
}

// ── categories ───────────────────────────────────────────────────────────────

describe("harness log — categories", () => {
  it("run_start + step land as run rows", () => {
    const s = fed({ type: "step", step: 2, maxSteps: 40 });
    assert.equal(s.log[0].cat, "run");
    assert.match(s.log[0].text, /run ▸ build: fix the flaky test/);
    assert.match(texts(s).at(-1), /^step 2\/40$/);
    assert.equal(byCat(s, "llm").length, 0);
  });

  it("llm stream → exactly ONE llm row, closed with real numbers by llm_usage", () => {
    const s = fed(
      { type: "step", step: 1, maxSteps: 10 },
      { type: "llm_delta", delta: "Hello" },
      { type: "llm_delta", delta: " world" },
      { type: "llm_usage", usage: { input_tokens: 1500, output_tokens: 700, cached_tokens: 200 } },
    );
    const rows = byCat(s, "llm");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.live, false);
    assert.equal(rows[0].meta.chunks, 2);
    assert.equal(rows[0].meta.tokensIn, 1500);
    assert.equal(rows[0].meta.tokensOut, 700);
    assert.match(rows[0].text, /llm #\d+ m1 · in 1\.5k out 700 \(cache 200\)/);
  });

  it("reasoning merges into the open llm row even when thinking is hidden", () => {
    const s = fed(
      { type: "llm_reasoning", delta: "hmm" },
      { type: "llm_delta", delta: "ok" },
      { type: "llm_usage", usage: { output_tokens: 5 } },
    );
    assert.equal(byCat(s, "llm").length, 1, "reasoning must not add a row");
    assert.equal(byCat(s, "llm")[0].meta.chunks, 2);
    assert.equal(byCat(s, "llm")[0].meta.live, false);
  });

  it("tool_call/output/progress → one shell row; tool_result closes it", () => {
    const s = fed(
      { type: "tool_call", step: 1, id: "c1", name: "run_command", args: { command: "ls -la /tmp" } },
      { type: "tool_output", name: "run_command", stream: "stdout", delta: "a".repeat(500) },
      { type: "tool_progress", id: "c1", name: "run_command", message: "still running" },
      { type: "tool_result", step: 1, id: "c1", name: "run_command", ok: true, output: "done" },
    );
    const shells = byCat(s, "shell");
    assert.equal(shells.length, 1, "stdout chunks and progress ticks must MERGE");
    assert.equal(shells[0].text, "▸ ls -la /tmp → ok · 0.0s");
    assert.equal(shells[0].meta.bytes, 500);
    assert.equal(shells[0].meta.count, 1);
    assert.equal(shells[0].meta.live, false);
    assert.equal(shells[0].meta.exit, true);
    assert.equal(shells[0].ref.callId, "c1");
    assert.ok(byCat(s, "tool").length === 0, "run_command is shell, not tool");
  });

  it("non-shell tool → tool row closed on result (FAILED verdict when !ok)", () => {
    const s = fed(
      { type: "tool_call", step: 2, id: "r1", name: "read_file", args: { path: "src/a.ts" } },
      { type: "tool_result", step: 2, id: "r1", name: "read_file", ok: false, output: "enoent" },
    );
    const t = byCat(s, "tool")[0];
    assert.match(t.text, /^read_file src\/a\.ts → FAILED/);
    assert.equal(t.meta.exit, false);
  });

  it("edit result adds a SEPARATE file row (+N -M path)", () => {
    const s = fed(
      { type: "tool_call", step: 3, id: "e1", name: "edit_file", args: { path: "src/a.ts" } },
      { type: "tool_result", step: 3, id: "e1", name: "edit_file", ok: true, output: "edited", diff: { path: "src/a.ts", text: "@@…", added: 4, removed: 1, truncated: false } },
    );
    const f = byCat(s, "file");
    assert.equal(f.length, 1);
    assert.equal(f[0].text, "+4 -1 src/a.ts");
    assert.equal(f[0].ref.callId, "e1");
    assert.equal(byCat(s, "tool").length, 1, "the tool row stays too");
  });

  it("build / guardrail / mcp / subagent / perm / sys buckets", () => {
    const s = fed(
      { type: "build", success: false, command: "npm run build", output: "" },
      { type: "guardrail", rule: "loop_guard", action: "block", reason: "same call 3×" },
      { type: "guardrail", rule: "output_budget", action: "trim", reason: "cap" },
      { type: "mcp_status", line: 'MCP "fs" ready — connected', server: "fs", state: "ready" },
      { type: "agent_start", id: "a1", name: "explore", description: "find tests", model: "m1" },
      { type: "agent_end", id: "a1", ok: true, steps: 5, summary: "3 files" },
      { type: "permission_request", id: "p1", kind: "shell", label: "run rm", command: "rm -rf x", timeoutSecs: 60 },
      { type: "question_request", id: "q1", question: "which target?", timeoutSecs: 60 },
      { type: "compaction", tokensBefore: 90_000, tokensAfter: 12_000, manual: true },
      { type: "queue", pending: 2, steering: 0 },
      { type: "error", message: "provider 502" },
    );
    assert.ok(texts(s).some((t) => t === "npm run build → FAIL"));
    assert.equal(byCat(s, "guard").length, 1, "trim must not spam the guard bucket");
    assert.equal(byCat(s, "mcp")[0].text, "fs ready");
    const subs = byCat(s, "sub");
    assert.equal(subs.length, 1, "start+end merge into ONE sub row");
    assert.equal(subs[0].text, "explore done · 5 steps");
    assert.equal(byCat(s, "perm").length, 2, "permission ask + question");
    assert.ok(texts(s).some((t) => t === "compact 90.0k→12.0k (manual)"));
    assert.ok(texts(s).some((t) => t === "queue 2 pending"));
    assert.ok(texts(s).some((t) => t === "error: provider 502"));
  });

  it("subagent row keeps FAILED verdict", () => {
    const s = fed(
      { type: "agent_start", id: "a9", name: "review", description: "audit", model: "m1" },
      { type: "agent_end", id: "a9", ok: false, steps: 2, summary: "boom" },
    );
    assert.match(byCat(s, "sub")[0].text, /review FAILED · 2 steps/);
  });

  it("finish + markAborted + logNote land run rows / notes", () => {
    const s = fed({ type: "finish", success: true, steps: 4, summary: "done: tests green" });
    assert.ok(byCat(s, "run").at(-1).text.includes("done: tests green"));
    markAborted(s);
    assert.ok(byCat(s, "run").at(-1).text.includes("abort requested"));
    logNote(s, "perm", "answer always: rm");
    assert.equal(s.log.at(-1).text, "answer always: rm");
  });

  it("warmup logs per STAGE change; context per 3-point move; todo per size change", () => {
    const s = fed(
      { type: "warmup", active: true, stage: "indexing", percent: 10, message: null },
      { type: "warmup", active: true, stage: "indexing", percent: 55, message: null },
      { type: "warmup", active: true, stage: "retrieval", percent: 80, message: null },
      { type: "warmup", active: false, stage: "idle", percent: 100, message: null },
      { type: "context", tokens: 10_000, window: 100_000, pct: 10 },
      { type: "context", tokens: 10_500, window: 100_000, pct: 11 },
      { type: "context", tokens: 14_000, window: 100_000, pct: 14 },
      { type: "todo", items: [{ content: "a", status: "pending" }, { content: "b", status: "pending" }] },
      { type: "todo", items: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] },
      { type: "todo", items: [{ content: "a", status: "completed" }] },
    );
    const sys = byCat(s, "sys");
    assert.ok(sys.some((e) => e.text.startsWith("warmup indexing 10%")));
    assert.ok(!sys.some((e) => e.text.startsWith("warmup indexing 55")), "ticks must not spam");
    assert.ok(sys.some((e) => e.text === "warmup idle"));
    const ctxs = sys.filter((e) => e.text.startsWith("ctx "));
    assert.equal(ctxs.length, 2, "10% → 11% suppressed (<3 pts), 10 → 14 logged");
    const plans = sys.filter((e) => e.text.startsWith("plan ·"));
    assert.equal(plans.length, 2, "size changes only (2 todos, then 1)");
  });
});

// ── ring buffer & invariants ────────────────────────────────────────────────

describe("harness log — ring buffer", () => {
  it("caps at MAX_LOG_ENTRIES and counts evicted rows", () => {
    const s = initialState();
    applyEvent(s, runStart);
    for (let i = 0; i < MAX_LOG_ENTRIES + 250; i++) applyEvent(s, { type: "build", success: true, command: `cmd ${i}`, output: "" });
    assert.equal(s.log.length, MAX_LOG_ENTRIES);
    assert.equal(s.logDropped, 251, "250 evicted builds + the run_start row");
    assert.equal(s.log[0].text, "cmd 250 → PASS", "oldest kept = first after eviction");
    assert.ok(s.log.at(-1).id > s.log[0].id, "ids keep growing monotonically");
  });

  it("entry ids are unique and monotonic across a mixed stream", () => {
    const s = fed(
      { type: "step", step: 1, maxSteps: 5 },
      { type: "llm_delta", delta: "x" },
      { type: "llm_usage", usage: { output_tokens: 1 } },
      { type: "tool_call", step: 1, id: "c", name: "glob", args: { pattern: "**" } },
      { type: "tool_result", step: 1, id: "c", name: "glob", ok: true, output: "1 file" },
      { type: "build", success: true, command: "tsc", output: "" },
    );
    const ids = s.log.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("summaries are capped at 200 chars", () => {
    const s = initialState();
    applyEvent(s, { ...runStart, task: "x".repeat(500) });
    assert.ok(s.log[0].text.length <= 200);
    assert.match(s.log[0].text, /…$/);
  });

  it("merging never mutates frozen entries — old references keep old values", () => {
    const s = initialState();
    applyEvent(s, runStart);
    applyEvent(s, { type: "tool_call", step: 1, id: "c1", name: "run_command", args: { command: "sleep 1" } });
    const openRow = s.log.at(-1);
    const openText = openRow.text;
    applyEvent(s, { type: "tool_output", name: "run_command", stream: "stdout", delta: "out" });
    applyEvent(s, { type: "tool_result", step: 1, id: "c1", name: "run_command", ok: true, output: "out" });
    assert.equal(openRow.text, openText, "the old object was REPLACED in the array, not mutated");
    assert.notEqual(s.log.at(-1), openRow);
    assert.equal(s.log.at(-1).meta.live, false);
  });

  it("entries carry lazy refs, never payloads", () => {
    const s = fed(
      { type: "tool_call", step: 4, id: "z", name: "grep", args: { pattern: "foo" } },
      { type: "tool_output", name: "grep", stream: "stdout", delta: "y".repeat(9000) },
      { type: "tool_result", step: 4, id: "z", name: "grep", ok: true, output: "y".repeat(9000) },
    );
    for (const e of s.log) assert.ok(e.text.length <= 200);
    assert.ok(s.log.every((e) => !("output" in e)));
  });
});
