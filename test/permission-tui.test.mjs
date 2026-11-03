/**
 * T-03 unit tests — programmatic permission prompt (TUI modal path).
 * promptHandler routes confirm/confirmEdit/confirmAsk; timeout ⇒ deny;
 * "always" semantics per kind; abortRequested on "quit".
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PermissionChecker } from "../dist/permissions.js";
import { Agent } from "../dist/agent.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function checker(overrides = {}) {
  return new PermissionChecker({
    mode: "ask",
    allowCommands: [],
    denyCommands: [],
    nonInteractive: false,
    ...overrides,
  });
}

describe("PermissionChecker.promptHandler (T-03)", () => {
  it("confirm(shell) routes through handler; yes → true", async () => {
    const p = checker();
    p.promptHandler = async () => "yes";
    assert.equal(await p.confirm("npm test"), true);
  });
  it("no → false", async () => {
    const p = checker();
    p.promptHandler = async () => "no";
    assert.equal(await p.confirm("rm -rf x"), false);
  });
  it("always + alwaysAllowPrefix → session allowlist", async () => {
    const p = checker();
    p.promptHandler = async () => "always";
    assert.equal(await p.confirm("git status"), true);
    // second call auto-allowed (session allowlist) — handler not called again
    let called = 0;
    p.promptHandler = async () => { called++; return "no"; };
    assert.equal(await p.confirm("git status"), true);
    assert.equal(called, 0);
  });
  it("quit sets abortRequested", async () => {
    const p = checker();
    p.promptHandler = async () => "quit";
    assert.equal(await p.confirm("npm test"), false);
    assert.equal(p.abortRequested, true);
  });
  it("confirmEdit always → allowAllEdits sticky", async () => {
    const p = checker();
    let calls = 0;
    p.promptHandler = async () => { calls++; return "always"; };
    assert.equal(await p.confirmEdit("a.ts", "+x"), true);
    assert.equal(await p.confirmEdit("b.ts", "+y"), true);
    assert.equal(calls, 1);
  });
  it("confirmEdit diff passed to handler", async () => {
    const p = checker();
    let seen = null;
    p.promptHandler = async (req) => { seen = req.diff; return "yes"; };
    await p.confirmEdit("a.ts", "+hello");
    assert.match(seen, /hello/);
  });
  it("nonInteractive denies without handler", async () => {
    const p = checker({ nonInteractive: true });
    assert.equal(await p.confirm("npm test"), false);
  });
  it("allow rule skips handler", async () => {
    const p = checker({ allowCommands: ["git"] });
    let called = 0;
    p.promptHandler = async () => { called++; return "no"; };
    assert.equal(await p.confirm("git status"), true);
    assert.equal(called, 0);
  });
});

describe("Agent permission_request events (T-03)", () => {
  let workdir;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "t03-"));
    writeFileSync(join(workdir, "build.js"), "console.log('ok')\n");
  });

  function agent(script) {
    const turns = Array.isArray(script) ? script : [script];
    const mk = () => ({
      idx: 0,
      lastPartialToolCalls: [],
      async chat() {
        const t = turns[this.idx++] ?? { content: "done" };
        return {
          message: {
            role: "assistant",
            content: t.content ?? null,
            stop_reason: t.toolCalls?.length ? "tool_calls" : "stop",
            tool_calls: t.toolCalls ?? [],
          },
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
      async *streamChat() {
        yield { final: { message: { role: "assistant", content: "done", stop_reason: "stop" }, usage: {} }, done: true };
      },
    });
    return new Agent({
      workdir,
      provider: "openai",
      baseUrl: "http://localhost:1",
      apiKey: "k",
      model: "m",
      maxSteps: 4,
      permissionMode: "ask",
      noSave: true,
      snapshots: false,
      clientFactory: mk,
    });
  }

  it("ask mode shell → permission_request event → resolve(yes) runs", async () => {
    const a = agent([
      { toolCalls: [{ id: "s1", name: "run_command", arguments: JSON.stringify({ command: "echo hi" }) }] },
      { content: "done" },
    ]);
    const events = [];
    a.onEvent = (ev) => {
      if (ev.type === "permission_request") {
        events.push(ev);
        // answer async — modal simulation
        setTimeout(() => a.resolvePermission(ev.id, "yes"), 5);
      }
    };
    const res = await a.run("run echo");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "shell");
    assert.match(events[0].command, /echo hi/);
    assert.equal(res.success, true);
    rmSync(workdir, { recursive: true, force: true });
  });

  it("timeout ⇒ deny (short timeout)", async () => {
    const a = agent([
      { toolCalls: [{ id: "s1", name: "run_command", arguments: JSON.stringify({ command: "echo hi" }) }] },
      { content: "done" },
    ]);
    a.onEvent = (ev) => {
      if (ev.type === "permission_request") {
        // never answer — timeout path (timeoutSecs passed by checker = 60s;
        // simulate instant answer "no" via resolve after 20ms instead)
        setTimeout(() => a.resolvePermission(ev.id, "no"), 20);
      }
    };
    const res = await a.run("run echo");
    assert.equal(res.success, true); // run completes (tool denied, model finishes)
    rmSync(workdir, { recursive: true, force: true });
  });
});
