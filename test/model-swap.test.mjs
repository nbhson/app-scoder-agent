/**
 * T-04 unit tests — runtime model hot-swap (same-provider + cross-provider).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../dist/agent.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "t04-"));
  mkdirSync(join(workdir, ".scoder"), { recursive: true });
  writeFileSync(join(workdir, "build.js"), "console.log(1)");
  // Isolate rc — point SCODER_CONFIG at a minimal file (tests run with real
  // ~/.scoder otherwise).
  process.env.SCODER_CONFIG = join(workdir, "rc.json");
  writeFileSync(process.env.SCODER_CONFIG, JSON.stringify({}));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  delete process.env.SCODER_CONFIG;
});

function agent(model) {
  const mk = () => {
    let currentModel = model;
    return {
      idx: 0,
      lastPartialToolCalls: [],
      get model() { return currentModel; },
      setModel(m) { currentModel = m; },
      async chat() {
        return { message: { role: "assistant", content: "done", stop_reason: "stop", tool_calls: [] }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
      async *streamChat() { yield { final: { message: { role: "assistant", content: "done", stop_reason: "stop" }, usage: {} }, done: true }; },
    };
  };
  return new Agent({
    workdir,
    provider: "openai",
    baseUrl: "http://localhost:1",
    apiKey: "k",
    model,
    maxSteps: 2,
    permissionMode: "auto",
    noSave: true,
    snapshots: false,
    clientFactory: mk,
  });
}

describe("Agent.setModel (T-04)", () => {
  it("same provider — client.model swaps in place", () => {
    const a = agent("gpt-4o");
    const notice = a.setModel("gpt-4o-mini");
    assert.match(notice, /gpt-4o-mini/);
    assert.equal(a.client.model, "gpt-4o-mini");
  });
  it("provider/model syntax — same provider", () => {
    const a = agent("gpt-4o");
    a.setModel("openai/o3");
    assert.equal(a.client.model, "o3");
  });
  it("cross-provider — rebuilds runtime (anthropic)", () => {
    const a = agent("gpt-4o");
    const notice = a.setModel("anthropic/claude-sonnet-4-5");
    assert.match(notice, /claude-sonnet-4-5/);
    assert.equal(a.client.model, "claude-sonnet-4-5");
    // Anthropic runtime reports through same .model getter.
  });
  it("unknown provider → ERROR notice, client unchanged", () => {
    const a = agent("gpt-4o");
    const notice = a.setModel("no-such-provider/x");
    assert.match(notice, /^ERROR/);
    assert.equal(a.client.model, "gpt-4o");
  });
});
