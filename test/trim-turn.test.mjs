/**
 * T-07 unit test — Agent.trimLastTurn (fork/edit-resend primitive), cộng thêm
 * dấu mốc run_start cho mọi entry point vào runLoop (sidebar/REPL realtime).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../dist/agent.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "t07-"));
  writeFileSync(join(workdir, "build.js"), "console.log(1)");
  process.env.SCODER_CONFIG = join(workdir, "rc.json");
  writeFileSync(process.env.SCODER_CONFIG, JSON.stringify({}));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  delete process.env.SCODER_CONFIG;
});

function mkAgent(overrides = {}) {
  const turns = [
    { content: "first answer" },
    { toolCalls: [{ id: "t1", name: "run_command", arguments: JSON.stringify({ command: "echo hi" }) }] },
    { content: "second answer" },
  ];
  const mk = () => ({
    idx: 0,
    lastPartialToolCalls: [],
    async chat() {
      const t = turns[this.idx++] ?? { content: "done" };
      return { message: { role: "assistant", content: t.content ?? null, stop_reason: t.toolCalls?.length ? "tool_calls" : "stop", tool_calls: t.toolCalls ?? [] }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
    async *streamChat() { yield { final: { message: { role: "assistant", content: "done", stop_reason: "stop" }, usage: {} }, done: true }; },
  });
  return new Agent({
    workdir,
    provider: "openai",
    baseUrl: "http://localhost:1",
    apiKey: "k",
    model: "m",
    maxSteps: 3,
    permissionMode: "auto",
    noSave: true,
    snapshots: false,
    clientFactory: mk,
    ...overrides,
  });
}

describe("Agent.trimLastTurn (T-07)", () => {
  it("removes the last user message + everything after", async () => {
    const a = mkAgent();
    await a.run("task one");
    await a.runTurn("task two");
    const before = a.messages.length;
    a.trimLastTurn();
    assert.ok(a.messages.length < before);
    // Tail = guardrail reminder tail của turn 1 (hoặc assistant khi không có
    // reminder) — KHÔNG được là 'task two' user message.
    const last = a.messages[a.messages.length - 1];
    assert.ok(last.role !== "user" || String(last.content).includes("system-reminder"), JSON.stringify(last));
  });
  it("empty messages → no throw", () => {
    const a = mkAgent();
    a.trimLastTurn();
    assert.equal(a.messages.length, 0);
  });
});

describe("Dấu mốc run_start cho mọi entry point (sidebar realtime)", () => {
  it("run() rồi runTurn() -> 2 run_start, task là nguyên văn user vừa gửi", async () => {
    const a = mkAgent();
    const events = [];
    a.onEvent = (ev) => events.push(ev);
    await a.run("task one");
    await a.runTurn("task two");
    const starts = events.filter((e) => e.type === "run_start");
    assert.equal(starts.length, 2, `runTurn phải phát cùng dấu mốc: ${starts.length}`);
    assert.equal(starts[1].task, "task two");
    assert.equal(starts[1].quiet, undefined, "turn thường thì UI dedupe theo text, không quiet");
    //Thứ tự quan trọng: reset anchor PHẢI tới trước step đầu tiên của lượt.
    const firstStepAfter = events.findIndex((e, i) => e.type === "step" && i > events.lastIndexOf(starts[1]));
    assert.ok(firstStepAfter > events.lastIndexOf(starts[1]), "run_start trước step của lượt đó");
  });

  it("run.started cũng được stamp cho lượt runTurn (event log liền mạch)", async () => {
    // noSave: false -> EventSessionStore ghi .scoder/sessions/<id>/events.jsonl.
    // Tắt watcher: khôngSave bật cả watchWorkdir() và giữ event loop sống mãi.
    process.env.SCODER_NO_WATCH = "1";
    const a = mkAgent({ noSave: false });
    try {
      await a.run("task one");
      await a.runTurn("task two");
    } finally {
      a.dispose?.();
      delete process.env.SCODER_NO_WATCH;
    }
    const dir = join(workdir, ".scoder", "sessions");
    const ids = readdirSync(dir).filter((d) => existsSync(join(dir, d, "events.jsonl")));
    assert.ok(ids.length >= 1, "phải có event log");
    const lines = readFileSync(join(dir, ids[ids.length - 1], "events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const started = lines.filter((l) => l.type === "run.started");
    assert.equal(started.length, 2, `2 run.started cho 2 lượt, có ${started.length}`);
    assert.equal(started[1].task, "task two");
  });

  it("resume() phát run_start quiet (transcript đã restore, không nhân đôi dòng user)", async () => {
    const a = mkAgent();
    await a.run("task one");
    const session = {
      id: "s1",
      createdAt: new Date().toISOString(),
      workdir,
      model: "m",
      provider: "openai",
      task: "task one",
      steps: 1,
      messages: a.messages,
    };
    const events = [];
    const b = mkAgent();
    b.onEvent = (ev) => events.push(ev);
    await b.resume(session);
    const start = events.find((e) => e.type === "run_start");
    assert.ok(start, "resume phải phát run_start để UI reset elapsed/tok-s");
    assert.equal(start.quiet, true);
  });
});
