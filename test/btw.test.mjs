/**
 * /btw unit tests — Agent.sideQuestion: một calls side-channel không tool trên
 * SNAPSHOT của history hiện tại; Q&A không bao giờ vào this.messages (prefix
 * giữ nguyên → provider KV-cache vẫn ấm); round tool-call chưa trả lời bị cắt
 * khỏi snapshot; /btw không arg replay đáp án gần nhất.
 * Chạy: node --test test/btw.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../dist/agent.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "btw-"));
  writeFileSync(join(workdir, "build.js"), "console.log(1)");
  process.env.SCODER_CONFIG = join(workdir, "rc.json");
  writeFileSync(process.env.SCODER_CONFIG, JSON.stringify({}));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  delete process.env.SCODER_CONFIG;
});

/** Fake client — ghi lại (messages snapshot, tools) của mỗi chat() call. */
function mkAgent(reply = "the helper reads .env") {
  const calls = [];
  const client = {
    model: "m",
    lastPartialToolCalls: [],
    setModel() {},
    async chat(messages, tools) {
      calls.push({ messages: messages.slice(), tools });
      return {
        message: { role: "assistant", content: reply, tool_calls: [] },
        usage: { prompt_tokens: 10, completion_tokens: 3, cached_tokens: 7 },
      };
    },
    async *streamChat() {
      yield { final: { message: { role: "assistant", content: reply, tool_calls: [] }, usage: {} }, done: true };
    },
  };
  const agent = new Agent({
    workdir,
    provider: "openai",
    baseUrl: "http://localhost:1",
    apiKey: "k",
    model: "m",
    maxSteps: 3,
    permissionMode: "auto",
    noSave: true,
    snapshots: false,
    stream: false,
    clientFactory: () => client,
  });
  return { agent, calls };
}

describe("Agent.sideQuestion (/btw)", () => {
  it("trả lời từ context, KHÔNG tool, Q&A không vào history, usage vẫn tính", async () => {
    const { agent, calls } = mkAgent();
    agent.messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "main task" },
      { role: "assistant", content: "main answer" },
    ];
    const r = await agent.sideQuestion("what does the helper do?");
    assert.equal(r.ok, true);
    assert.equal(r.answer, "the helper reads .env");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].tools, [], "side call không được offer tool nào");
    const sent = calls[0].messages;
    assert.equal(sent.length, 4, "snapshot history + 1 user message chứa câu hỏi");
    assert.deepEqual(sent.slice(0, 3), agent.messages.slice(0, 3), "prefix giữ NGUYÊN văn — KV-cache còn dùng được");
    assert.equal(sent[3].role, "user");
    assert.match(sent[3].content, /what does the helper do\?/);
    assert.equal(agent.messages.length, 3, "history chính không bị nối Q&A");
    const u = agent.getUsage();
    assert.equal(u.calls, 1, "/cost vẫn nhìn thấy side call");
    assert.equal(u.inputTokens, 10);
    assert.equal(u.outputTokens, 3);
    assert.equal(u.cachedTokens, 7);
  });

  it("snapshot giữa run: cắt round tool-call CHƯA được trả lời hết", async () => {
    const { agent, calls } = mkAgent();
    agent.messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", name: "run_command", arguments: "{}" }] },
      { role: "tool", tool_call_id: "t1", name: "run_command", content: "ok" },
      // run-loop đang chờ kết quả t2 — dangling tool_calls bị provider từ chối:
      { role: "assistant", content: null, tool_calls: [{ id: "t2", name: "read_file", arguments: "{}" }] },
    ];
    const before = agent.messages.length;
    const r = await agent.sideQuestion("why?");
    assert.equal(r.ok, true);
    const sent = calls[0].messages;
    assert.equal(sent.length, 5, "4 message trọn vẹn (không tính t2) + câu hỏi side");
    assert.ok(sent.some((m) => m.tool_call_id === "t1"), "round t1 đã trả lời đủ → GIỮ lại");
    assert.ok(!sent.some((m) => m.tool_calls?.some((tc) => tc.id === "t2")), "assistant t2 thiếu tool result → bị cắt");
    assert.equal(agent.messages.length, before, "agent thật không mất message nào");
  });

  it("round tool-call cuối ĐÃ đủ tool result → giữ nguyên snapshot", async () => {
    const { agent, calls } = mkAgent();
    agent.messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", name: "run_command", arguments: "{}" }] },
      { role: "tool", tool_call_id: "t1", name: "run_command", content: "ok" },
    ];
    await agent.sideQuestion("quick fact?");
    assert.equal(calls[0].messages.length, 5, "system+user+assistant+tool + câu hỏi");
    assert.ok(calls[0].messages.some((m) => m.tool_call_id === "t1"));
  });

  it("/btw không arg: replay đáp án gần nhất, không gọi LLM; chưa có gì → usage warn", async () => {
    const { agent, calls } = mkAgent("answer-1");
    let r = await agent.sideQuestion("");
    assert.equal(r.ok, false, "chưa từng hỏi → usage");
    assert.match(r.answer, /usage: \/btw/);
    agent.messages = [{ role: "user", content: "hi" }];
    await agent.sideQuestion("first question");
    assert.equal(calls.length, 1);
    r = await agent.sideQuestion("   ");
    assert.equal(r.ok, true);
    assert.match(r.answer, /first question/, "kèm lại câu hỏi để biết replay của cái gì");
    assert.match(r.answer, /answer-1/);
    assert.equal(calls.length, 1, "replay không tốn LLM call");
  });

  it("side call lỗi → ok:false, agent chạy tiếp bình thường", async () => {
    const { agent } = mkAgent();
    agent.client = {
      model: "m",
      lastPartialToolCalls: [],
      setModel() {},
      async chat() {
        throw new Error("boom");
      },
      async *streamChat() {},
    };
    agent.messages = [{ role: "user", content: "hi" }];
    const r = await agent.sideQuestion("hello?");
    assert.equal(r.ok, false);
    assert.match(r.answer, /side question failed: boom/);
    assert.equal(agent.messages.length, 1, "lỗi side call không đụng history");
  });
});
