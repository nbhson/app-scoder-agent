/**
 * Manual compaction (`/compact`) — Agent.compactHistory().
 * Chạy: node --test test/compact-manual.test.mjs (sau npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../dist/agent.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "compact-manual-"));
  process.env.SCODER_CONFIG = join(workdir, "rc.json");
  writeFileSync(process.env.SCODER_CONFIG, JSON.stringify({}));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  delete process.env.SCODER_CONFIG;
});

function mkAgent(over = {}) {
  const mk = () => ({
    async chat() {
      return {
        message: { role: "assistant", content: "SUMMARY", stop_reason: "stop" },
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
    async *streamChat() {
      yield { final: { message: { role: "assistant", content: "SUMMARY", stop_reason: "stop" }, usage: {} }, done: true };
    },
  });
  return new Agent({
    workdir,
    provider: "openai",
    baseUrl: "http://localhost:1",
    apiKey: "k",
    model: "m",
    maxSteps: 2,
    permissionMode: "auto",
    noSave: true,
    snapshots: false,
    // keep/buffer 0 → cut ngay tại user message gần nhất, dễ assert.
    compaction: { keep: 0, buffer: 0 },
    clientFactory: mk,
    ...over,
  });
}

const longHistory = () => [
  { role: "system", content: "sys" },
  { role: "user", content: "old task ".repeat(200) },
  { role: "assistant", content: "old answer ".repeat(200) },
  { role: "user", content: "middle task ".repeat(100) },
  { role: "assistant", content: "middle answer ".repeat(100) },
  { role: "user", content: "latest" },
];

describe("Agent.compactHistory (manual /compact)", () => {
  it("tóm tắt history cũ, giữ system + message gần nhất", async () => {
    const a = mkAgent();
    a.messages = longHistory();
    const before = a.messages.length;
    const r = await a.compactHistory();
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /compaction done/);
    assert.ok(a.messages.length < before, `phải shrink (${before} → ${a.messages.length})`);
    assert.equal(a.messages[0].content, "sys");
    assert.match(String(a.messages[1].content), /Session summary \(auto-compact\)/);
    assert.match(String(a.messages[1].content), /SUMMARY/);
    assert.equal(a.messages[a.messages.length - 1].content, "latest");
  });

  it("vẫn chạy khi auto-compaction bị tắt (compaction: false)", async () => {
    const a = mkAgent({ compaction: false });
    a.messages = longHistory();
    const r = await a.compactHistory();
    assert.equal(r.ok, true, r.message);
  });

  it("history rỗng → ok:false, không gọi LLM", async () => {
    const a = mkAgent();
    const r = await a.compactHistory();
    assert.equal(r.ok, false);
    assert.match(r.message, /no conversation yet/);
  });

  it("history ngắn (system + 1 user) → ok:false", async () => {
    const a = mkAgent();
    a.messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const r = await a.compactHistory();
    assert.equal(r.ok, false);
    assert.match(r.message, /already short/);
  });
});
