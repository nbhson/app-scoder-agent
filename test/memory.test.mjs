/**
 * Phase 2 — Planning 2.0 + memory + compaction v2.
 * Chạy: npm run build && node --test test/memory.test.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  memoryFromMessages,
  formatWorkingMemory,
  memoryIsMeaningful,
  emptyWorkingMemory,
  notePlan,
  noteFailure,
} from "../dist/memory.js";
import { COMPACTION_INSTRUCTION } from "../dist/compaction.js";
import { getTool } from "../dist/tools.js";
import { Agent } from "../dist/agent.js";

const TMP = mkdtempSync(join(tmpdir(), "scoder-mem-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const history = () => [
  { role: "system", content: "sys" },
  { role: "user", content: "fix the parser bug" },
  { role: "assistant", content: "Decision: use the two-pass approach", tool_calls: [
    { id: "1", name: "read_file", arguments: JSON.stringify({ path: "src/parser.ts" }) },
    { id: "2", name: "edit_file", arguments: JSON.stringify({ path: "src/parser.ts", old_string: "a", new_string: "b" }) },
    { id: "3", name: "write_todos", arguments: JSON.stringify({ todos: [
      { content: "repro", status: "completed" },
      { content: "fix crash", status: "in_progress", verify: "npm test" },
    ] }) },
  ] },
  { role: "tool", tool_call_id: "1", name: "read_file", content: "1: const x = 1" },
  { role: "tool", tool_call_id: "2", name: "edit_file", content: "Edited src/parser.ts" },
  { role: "tool", tool_call_id: "3", name: "write_todos", content: "Plan updated: 1/2 completed." },
  { role: "tool", tool_call_id: "4", name: "run_command", content: "ERROR: Failed to compile: TS2322 type mismatch" },
];

describe("memoryFromMessages — ledger rebuild (resume path)", () => {
  it("extracts goal, files read/changed, failures, plan, decisions", () => {
    const mem = memoryFromMessages(history(), "fix the parser bug");
    assert.equal(mem.goal, "fix the parser bug");
    assert.deepEqual(mem.filesRead, ["src/parser.ts"]);
    assert.deepEqual(mem.filesChanged, ["src/parser.ts"]);
    assert.ok(mem.failures.some((f) => /TS2322/.test(f)), `failures: ${mem.failures}`);
    assert.ok(mem.nextSteps.some((s) => /fix crash/.test(s)), `nextSteps: ${mem.nextSteps}`);
    assert.ok(mem.decisions.some((d) => /two-pass/.test(d)), `decisions: ${mem.decisions}`);
    assert.equal(memoryIsMeaningful(mem), true);
  });

  it("empty history → not meaningful", () => {
    assert.equal(memoryIsMeaningful(emptyWorkingMemory()), false);
  });
});

describe("formatWorkingMemory — bounded output", () => {
  it("stays within the ~1.5k token budget on heavy input", () => {
    const mem = emptyWorkingMemory("g");
    for (let i = 0; i < 40; i++) mem.filesRead.push(`src/very/long/path/name/file${i}.ts`);
    for (let i = 0; i < 40; i++) mem.filesChanged.push(`src/very/long/path/name/changed${i}.ts`);
    for (let i = 0; i < 30; i++) noteFailure(mem, `failure ${i} with a rather long message body to fill space`);
    const out = formatWorkingMemory(mem);
    assert.ok(out.length <= 6000, `ledger too big: ${out.length} chars`);
    assert.match(out, /working memory/);
  });
});

describe("notePlan / noteFailure caps", () => {
  it("caps failures at 10 and keeps the newest", () => {
    const mem = emptyWorkingMemory();
    for (let i = 0; i < 15; i++) noteFailure(mem, `f${i}`);
    assert.equal(mem.failures.length, 10);
    assert.equal(mem.failures[0], "f5");
  });

  it("notePlan keeps only unfinished steps", () => {
    const mem = emptyWorkingMemory();
    notePlan(mem, [
      { content: "done", status: "completed" },
      { content: "active", status: "in_progress" },
      { content: "later", status: "pending" },
    ]);
    assert.deepEqual(mem.nextSteps.map((s) => s.slice(2)), ["active", "later"]);
  });
});

describe("write_todos v2", () => {
  it("auto-assigns ids, stores verify/acceptance/files/depends_on", async () => {
    const wd = mkdtempSync(join(TMP, "todos-"));
    const saved = [];
    const ctx = { workdir: wd, permissionMode: "auto", plan: { get: () => [], set: (items) => saved.push(items) } };
    const tool = getTool("write_todos");
    const r = await tool.run(ctx, { todos: [
      { content: "repro the bug", status: "completed", verify: "npm test fails with TS2322" },
      { content: "fix crash", status: "in_progress", verify: "npm test", acceptance: "all green", files: ["src/parser.ts"], depends_on: ["t1"] },
    ] });
    assert.equal(r.ok, true, r.output);
    const items = saved[saved.length - 1];
    assert.equal(items[0].id, "t1");
    assert.equal(items[1].id, "t2");
    assert.equal(items[0].verify, "npm test fails with TS2322");
    assert.equal(items[1].acceptance, "all green");
    assert.deepEqual(items[1].files, ["src/parser.ts"]);
    assert.deepEqual(items[1].depends_on, ["t1"]);
  });

  it("rejects more than one in_progress", async () => {
    const wd = mkdtempSync(join(TMP, "todos2-"));
    const ctx = { workdir: wd, permissionMode: "auto", plan: { get: () => [], set: () => {} } };
    const tool = getTool("write_todos");
    const r = await tool.run(ctx, { todos: [
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
    ] });
    assert.equal(r.ok, false);
    assert.match(r.output, /exactly one in_progress/);
  });

  it("rejects depends_on pointing at an unknown id", async () => {
    const wd = mkdtempSync(join(TMP, "todos3-"));
    const ctx = { workdir: wd, permissionMode: "auto", plan: { get: () => [], set: () => {} } };
    const tool = getTool("write_todos");
    const r = await tool.run(ctx, { todos: [
      { content: "orphan", status: "pending", depends_on: ["nope"] },
    ] });
    assert.equal(r.ok, false);
    assert.match(r.output, /unknown id "nope"/);
  });
});

describe("compaction v2 — ledger folded into the summarizer call", () => {
  it("COMPACTION_INSTRUCTION uses the structured template", () => {
    for (const section of ["GOAL", "STATE", "CHANGED", "DECISIONS", "FAILURES", "NEXT"]) {
      assert.ok(COMPACTION_INSTRUCTION.includes(section), `missing ${section}`);
    }
  });

  it("summarizer input carries the working-memory ledger", async () => {
    const wd = mkdtempSync(join(TMP, "compact-"));
    writeFileSync(join(wd, "parser.ts"), "export const x = 1;\n");
    let summarizerInput = null;
    const tc = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args ?? {}) } });
    const ScriptedClient = class {
      lastPartialToolCalls = [];
      get model() { return "scripted/mock"; }
      constructor() {
        this.turns = [
          { toolCalls: [tc("r1", "read_file", { path: "parser.ts" })] },
          { content: "SUMMARY" }, // compaction summarizer call
          { content: "done" },
        ];
        this.idx = 0;
      }
      next() {
        const t = this.turns[this.idx++] ?? { content: "done" };
        const toolCalls = t.toolCalls?.map((x) => ({ id: x.id, name: x.function.name, arguments: x.function.arguments }));
        return {
          message: { role: "assistant", content: t.content ?? null, stop_reason: toolCalls ? "tool_calls" : "stop", tool_calls: toolCalls },
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      }
      async chat(messages) {
        const r = this.next();
        if (r.message.content === "SUMMARY") summarizerInput = messages;
        return r;
      }
      async *streamChat() { const r = this.next(); yield { contentDelta: r.message.content ?? "", done: false }; yield { final: r, done: true }; }
    };
    const agent = new Agent({
      baseUrl: "http://localhost:0",
      apiKey: "eval",
      model: "scripted/mock",
      provider: "openai",
      workdir: wd,
      buildCmd: null,
      maxSteps: 4,
      yes: true,
      noSave: true,
      snapshots: false,
      stream: false,
      permissionMode: "auto",
      compaction: { trigger: 0.01, keep: 0, buffer: 0, contextWindow: 100 },
      clientFactory: () => new ScriptedClient(),
      allowSubagents: false,
    });
    await agent.run("read parser.ts and summarize it");
    assert.ok(summarizerInput, "compaction summarizer was called");
    const last = summarizerInput[summarizerInput.length - 1];
    const content = typeof last.content === "string" ? last.content : "";
    assert.match(content, /Working memory ledger/i);
    assert.match(content, /parser\.ts/);
    assert.match(content, /STRUCTURED template/i);
  });
});

describe("plan-before-edit nudge (soft guardrail)", () => {
  const tc = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args ?? {}) } });
  function mkAgent(wd, turns) {
    const client = class {
      lastPartialToolCalls = [];
      get model() { return "scripted/mock"; }
      constructor() { this.turns = turns; this.idx = 0; }
      next() {
        const t = this.turns[this.idx++] ?? { content: "done" };
        const toolCalls = t.toolCalls?.map((x) => ({ id: x.id, name: x.function.name, arguments: x.function.arguments }));
        return {
          message: { role: "assistant", content: t.content ?? null, stop_reason: toolCalls ? "tool_calls" : "stop", tool_calls: toolCalls },
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      }
      async chat() { return this.next(); }
      async *streamChat() {
        const r = this.next();
        if (r.message.content) yield { contentDelta: r.message.content, done: false };
        if (r.message.tool_calls) {
          for (const c of r.message.tool_calls) yield { toolCallDelta: { index: 0, id: c.id, name: c.name, argumentsDelta: c.arguments }, done: false };
        }
        yield { final: r, done: true };
      }
    };
    return new Agent({
      baseUrl: "http://localhost:0",
      apiKey: "eval",
      model: "scripted/mock",
      provider: "openai",
      workdir: wd,
      buildCmd: null,
      maxSteps: 6,
      yes: true,
      noSave: true,
      snapshots: false,
      stream: false,
      permissionMode: "auto",
      clientFactory: () => new client(),
    });
  }

  it("editing with no plan injects exactly one reminder", async () => {
    const wd = mkdtempSync(join(TMP, "nudge-"));
    writeFileSync(join(wd, "a.txt"), "x\n");
    const agent = mkAgent(wd, [
      { toolCalls: [tc("w1", "write_file", { path: "a.txt", content: "y\n" })] },
      { content: "done" },
    ]);
    await agent.run("update a.txt");
    const nudges = agent.messages.filter((m) => typeof m.content === "string" && m.content.includes("without a plan"));
    assert.equal(nudges.length, 1);
  });

  it("editing with a written plan does NOT nudge", async () => {
    const wd = mkdtempSync(join(TMP, "nudge2-"));
    writeFileSync(join(wd, "b.txt"), "x\n");
    const agent = mkAgent(wd, [
      { toolCalls: [tc("p1", "write_todos", { todos: [{ content: "update b.txt", status: "in_progress" }] })] },
      { toolCalls: [tc("w1", "write_file", { path: "b.txt", content: "y\n" })] },
      { content: "done" },
    ]);
    await agent.run("update b.txt");
    const nudges = agent.messages.filter((m) => typeof m.content === "string" && m.content.includes("without a plan"));
    assert.equal(nudges.length, 0);
  });
});

describe("/plan command", () => {
  it("bare /plan renders plan with verify; /plan done marks completed", async () => {
    const { dispatchCommand } = await import("../dist/tui/command-registry.js");
    const calls = [];
    const agentStub = {
      getPlan: () => [
        { id: "t1", content: "repro", status: "completed" },
        { id: "t2", content: "fix crash", status: "in_progress", verify: "npm test", acceptance: "green" },
      ],
      markPlanStep: (status, ref) => {
        calls.push([status, ref]);
        return { ok: true, message: `step marked ${status}` };
      },
    };
    const notices = [];
    const host = {
      agent: () => agentStub,
      config: { workdir: TMP, permissionMode: "auto" },
      replaceAgent: () => {},
    };
    const notice = (text) => notices.push(text);
    await dispatchCommand("/plan", host, notice);
    const out = notices.join("\n");
    assert.match(out, /Plan:/);
    assert.match(out, /repro/);
    assert.match(out, /verify: npm test/);
    assert.match(out, /acceptance: green/);
    await dispatchCommand("/plan done 2", host, notice);
    assert.deepEqual(calls, [["completed", "2"]]);
  });

  it("bare /plan with no plan says so", async () => {
    const { dispatchCommand } = await import("../dist/tui/command-registry.js");
    const notices = [];
    const host = {
      agent: () => ({ getPlan: () => [], markPlanStep: () => ({ ok: false, message: "no plan" }) }),
      config: { workdir: TMP, permissionMode: "auto" },
      replaceAgent: () => {},
    };
    await dispatchCommand("/plan", host, (text) => notices.push(text));
    assert.match(notices.join("\n"), /no plan yet/);
  });
});
