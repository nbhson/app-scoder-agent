/**
 * Unit tests cho reasoning/thinking (I-05).
 * Chạy: node --test test/reasoning.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AnthropicClient } from "../dist/provider-anthropic.js";
import { LlmClient } from "../dist/llm.js";

describe("reasoning parse (I-05)", () => {
  let server;
  let lastBody;
  let port;

  beforeEach(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastBody = JSON.parse(body);
        const isAnthropic = req.url.includes("/messages");
        res.writeHead(200, { "Content-Type": isAnthropic ? "application/json" : "application/json" });
        if (isAnthropic) {
          res.end(JSON.stringify({
            content: [
              { type: "thinking", thinking: "Let me analyze..." },
              { type: "text", text: "Answer here" },
            ],
            usage: { input_tokens: 10, output_tokens: 20 },
            stop_reason: "end_turn",
          }));
        } else {
          res.end(JSON.stringify({
            choices: [{ message: { content: "Answer", reasoning_content: "Chain of thought..." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 10 },
          }));
        }
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it("OpenAI-compat: reasoning_content → message.reasoning", async () => {
    const c = new LlmClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "m", maxTokens: 100, temperature: 0 });
    const r = await c.chat([{ role: "user", content: "q" }], []);
    assert.equal(r.message.reasoning, "Chain of thought...");
    assert.equal(r.message.content, "Answer");
  });

  it("Anthropic: thinking block → message.reasoning", async () => {
    const c = new AnthropicClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "m", maxTokens: 100, temperature: 0 });
    const r = await c.chat([{ role: "user", content: "q" }], []);
    assert.equal(r.message.reasoning, "Let me analyze...");
    assert.equal(r.message.content, "Answer here");
  });

  it("reasoning on → Anthropic body có thinking param + temperature 1", async () => {
    const c = new AnthropicClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "m", maxTokens: 4000, temperature: 0.2, thinkingBudgetTokens: 1024 });
    await c.chat([{ role: "user", content: "q" }], []);
    assert.deepEqual(lastBody.thinking, { type: "enabled", budget_tokens: 1024 });
    assert.equal(lastBody.temperature, 1);
  });

  it("reasoning off → body không có thinking param", async () => {
    const c = new AnthropicClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "m", maxTokens: 100, temperature: 0.2 });
    await c.chat([{ role: "user", content: "q" }], []);
    assert.equal(lastBody.thinking, undefined);
    assert.equal(lastBody.temperature, 0.2);
  });

  it("Anthropic stream: thinking_delta → reasoningDelta chunks", async () => {
    await new Promise((r) => server.close(r));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think..." } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ans" } })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`);
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port2 = server.address().port;
    const c = new AnthropicClient({ baseUrl: `http://127.0.0.1:${port2}`, apiKey: "k", model: "m", maxTokens: 100, temperature: 0 });
    const chunks = [];
    for await (const ch of c.streamChat([{ role: "user", content: "q" }], [])) chunks.push(ch);
    assert.ok(chunks.some((ch) => ch.reasoningDelta === "think..."));
    const final = chunks.find((ch) => ch.final)?.final;
    assert.equal(final?.message?.reasoning, "think...");
  });
});
