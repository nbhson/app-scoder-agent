/**
 * Unit tests cho Anthropic prompt caching (I-04).
 * Chạy: node --test test/anthropic-cache.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AnthropicClient } from "../dist/provider-anthropic.js";

let server;
let lastBody;
let port;

beforeEach(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

const MESSAGES = [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "do the task" },
];

const TOOLS = [
  { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } },
  { type: "function", function: { name: "write_file", description: "write", parameters: { type: "object" } } },
];

describe("AnthropicClient cache_control (I-04)", () => {
  it("enableCache: system → block array với cache_control", async () => {
    const c = new AnthropicClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "m", maxTokens: 100, temperature: 0, enableCache: true });
    await c.chat(MESSAGES, TOOLS);
    assert.ok(Array.isArray(lastBody.system), "system là block array");
    assert.equal(lastBody.system[0].cache_control.type, "ephemeral");
  });

  it("enableCache: tool CUỐI mang cache_control, đầu không", async () => {
    const c = new AnthropicClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "m", maxTokens: 100, temperature: 0, enableCache: true });
    await c.chat(MESSAGES, TOOLS);
    assert.ok(!lastBody.tools[0].cache_control);
    assert.equal(lastBody.tools[1].cache_control.type, "ephemeral");
  });

  it("enableCache: last user turn được annotate", async () => {
    const c = new AnthropicClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "m", maxTokens: 100, temperature: 0, enableCache: true });
    await c.chat(MESSAGES, TOOLS);
    const msgs = lastBody.messages;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    assert.ok(Array.isArray(lastUser.content));
    assert.equal(lastUser.content[lastUser.content.length - 1].cache_control.type, "ephemeral");
    // Chỉ 1 user turn được annotate (4-block formula).
    const annotated = msgs.filter((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.cache_control));
    assert.equal(annotated.length, 1);
  });

  it("KHÔNG enableCache: wire format giữ nguyên (system string)", async () => {
    const c = new AnthropicClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "m", maxTokens: 100, temperature: 0 });
    await c.chat(MESSAGES, TOOLS);
    assert.equal(lastBody.system, "You are a coding agent.");
    assert.ok(!JSON.stringify(lastBody).includes("cache_control"));
  });

  it("streamChat cũng áp dụng cache", async () => {
    // mock SSE
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`);
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port2 = server.address().port;
    const c = new AnthropicClient({ baseUrl: `http://127.0.0.1:${port2}`, apiKey: "k", model: "m", maxTokens: 100, temperature: 0, enableCache: true });
    for await (const _ of c.streamChat(MESSAGES, TOOLS)) { void _; }
    assert.equal(lastBody.system[0].cache_control.type, "ephemeral");
    assert.equal(lastBody.tools[1].cache_control.type, "ephemeral");
  });
});
