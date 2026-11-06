/**
 * T-07 unit test — Agent.trimLastTurn (fork/edit-resend primitive).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../dist/agent.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function mkAgent() {
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
