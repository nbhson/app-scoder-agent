/**
 * Unit tests cho provider-anthropic.js — message translation + SSE streaming.
 * Chạy: node --test test/anthropic.test.mjs (sau khi npm run build)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { toAnthropicMessages, fromAnthropicResponse, AnthropicClient } from "../dist/provider-anthropic.js";

// ── Translation ─────────────────────────────────────────────────────────────

describe("toAnthropicMessages", () => {
  it("system message -> trường system riêng", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(system, "be nice");
    assert.deepEqual(messages, [{ role: "user", content: "hi" }]);
  });

  it("tool result -> user message với tool_result block", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "run it" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", name: "run_command", arguments: '{"command":"ls"}' }] },
      { role: "tool", tool_call_id: "tc1", content: "file1\nfile2" },
    ]);
    assert.equal(messages.length, 3, "user, assistant, user(tool_result)");
    assert.equal(messages[2].role, "user");
    const blocks = messages[2].content;
    assert.equal(blocks[0].type, "tool_result");
    assert.equal(blocks[0].tool_use_id, "tc1");
    assert.equal(blocks[0].content, "file1\nfile2");
  });

  it("assistant tool_calls -> tool_use blocks với input đã parse", () => {
    const { messages } = toAnthropicMessages([
      { role: "assistant", content: "let me check", tool_calls: [{ id: "tc9", name: "read_file", arguments: '{"path":"a.ts"}' }] },
    ]);
    const blocks = messages[0].content;
    assert.equal(blocks[0].type, "text");
    assert.equal(blocks[0].text, "let me check");
    assert.equal(blocks[1].type, "tool_use");
    assert.equal(blocks[1].name, "read_file");
    assert.deepEqual(blocks[1].input, { path: "a.ts" });
  });

  it("arguments JSON hỏng -> input {} (không crash)", () => {
    const { messages } = toAnthropicMessages([
      { role: "assistant", content: null, tool_calls: [{ id: "x", name: "t", arguments: "{broken" }] },
    ]);
    assert.deepEqual(messages[0].content[0].input, {});
  });

  it("nhiều tool result liên tiếp -> gộp vào 1 user message", () => {
    const { messages } = toAnthropicMessages([
      { role: "assistant", content: null, tool_calls: [{ id: "a", name: "t1", arguments: "{}" }, { id: "b", name: "t2", arguments: "{}" }] },
      { role: "tool", tool_call_id: "a", content: "r1" },
      { role: "tool", tool_call_id: "b", content: "r2" },
    ]);
    assert.equal(messages.length, 2, "assistant + 1 user message gộp 2 tool_result");
    assert.equal(messages[1].content.length, 2);
  });
});

describe("fromAnthropicResponse", () => {
  it("text blocks -> content nối bằng newline", () => {
    const r = fromAnthropicResponse({
      content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    assert.equal(r.message.content, "part1\npart2");
    assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5 });
  });

  it("tool_use blocks -> tool_calls với arguments JSON.stringify", () => {
    const r = fromAnthropicResponse({
      content: [{ type: "tool_use", id: "t1", name: "write_file", input: { path: "x", content: "y" } }],
    });
    assert.equal(r.message.tool_calls.length, 1);
    assert.equal(r.message.tool_calls[0].name, "write_file");
    assert.equal(r.message.tool_calls[0].arguments, '{"path":"x","content":"y"}');
    assert.equal(r.message.content, null);
  });
});

// ── SSE Streaming (mock server) ─────────────────────────────────────────────

describe("AnthropicClient.streamChat — SSE parsing", () => {
  let server;
  let port;

  const SSE_RESPONSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":42}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"run_command","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":1}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":17}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join("\n");

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      res.end(SSE_RESPONSE);
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    port = server.address().port;
  });

  after(() => new Promise((res) => {
    server.closeAllConnections?.();
    server.close(() => res());
  }));

  it("stream text deltas + tool_use accumulation + final result", async () => {
    const client = new AnthropicClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "test-key",
      model: "claude-sonnet-4-5",
      maxTokens: 100,
      temperature: 0,
    });

    let streamedText = "";
    let final;
    for await (const chunk of client.streamChat([{ role: "user", content: "go" }], [])) {
      if (chunk.contentDelta) streamedText += chunk.contentDelta;
      if (chunk.done) final = chunk.final;
    }

    assert.equal(streamedText, "Hello world", "text deltas stream real-time");
    assert.ok(final, "có final result");
    assert.equal(final.message.content, "Hello world");
    assert.equal(final.message.stop_reason, "tool_use");
    assert.equal(final.message.tool_calls.length, 1);
    assert.equal(final.message.tool_calls[0].id, "tu_1");
    assert.equal(final.message.tool_calls[0].name, "run_command");
    assert.equal(final.message.tool_calls[0].arguments, '{"command":"ls"}', "arguments ghép từ 2 partial_json");
    assert.deepEqual(final.usage, { prompt_tokens: 42, completion_tokens: 17 });
  });
});

describe("AnthropicClient.streamChat — error status", () => {
  it("429 -> LlmError với status", { timeout: 20_000 }, async () => {
    const server = createServer((req, res) => {
      res.writeHead(429, { "Content-Type": "application/json", Connection: "close" });
      res.end('{"error":{"message":"rate limited"}}');
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;

    const client = new AnthropicClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "k", model: "claude-3", maxTokens: 10, temperature: 0,
    });

    try {
      await assert.rejects(
        async () => {
          for await (const _ of client.streamChat([{ role: "user", content: "x" }], [])) { /* drain */ }
        },
        (err) => err.status === 429 || /rate|429/.test(err.message),
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise((res) => server.close(res));
    }
  });
});
