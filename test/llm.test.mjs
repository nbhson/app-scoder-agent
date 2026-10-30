/**
 * Unit tests cho llm.js — LlmClient SSE streaming với mock OpenAI-compatible server.
 * Chạy: node --test test/llm.test.mjs (sau khi npm run build)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { LlmClient, LlmError, LLM_REQUEST_TIMEOUT_MS } from "../dist/llm.js";

const makeClient = (port) =>
  new LlmClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: "test-key",
    model: "test-model",
    maxTokens: 100,
    temperature: 0,
  });

// ── Non-streaming ───────────────────────────────────────────────────────────

describe("LlmClient.chat", () => {
  let server;
  let port;
  let receivedBody;

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: "answer text",
              tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
            },
          }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }));
      });
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    port = server.address().port;
  });

  after(() => new Promise((res) => { server.closeAllConnections?.(); server.close(() => res()); }));

  it("parse message + tool_calls + usage", async () => {
    const r = await makeClient(port).chat([{ role: "user", content: "hi" }], []);
    assert.equal(r.message.content, "answer text");
    assert.equal(r.message.tool_calls[0].id, "call_1");
    assert.equal(r.message.tool_calls[0].name, "read_file");
    assert.equal(r.message.tool_calls[0].arguments, '{"path":"a.ts"}');
    assert.equal(r.usage.prompt_tokens, 11);
    assert.equal(r.usage.completion_tokens, 7);
  });

  it("gửi tools + model + stream:false đúng format", async () => {
    await makeClient(port).chat([{ role: "user", content: "x" }], [
      { type: "function", function: { name: "t1", description: "d", parameters: {} } },
    ]);
    assert.equal(receivedBody.model, "test-model");
    assert.equal(receivedBody.stream, false);
    assert.equal(receivedBody.tools[0].function.name, "t1");
  });
});

// ── Streaming ───────────────────────────────────────────────────────────────

describe("LlmClient.streamChat — SSE parsing", () => {
  let server;
  let port;

  const SSE = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\\"path\\":"}}]}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}',
    "",
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      res.end(SSE);
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    port = server.address().port;
  });

  after(() => new Promise((res) => { server.closeAllConnections?.(); server.close(() => res()); }));

  it("stream deltas + accumulate tool_calls + final chunk", async () => {
    const client = makeClient(port);
    let text = "";
    let final;
    for await (const chunk of client.streamChat([{ role: "user", content: "go" }], [])) {
      if (chunk.contentDelta) text += chunk.contentDelta;
      if (chunk.done) final = chunk.final;
    }
    assert.equal(text, "Hello", "content deltas stream real-time");
    assert.ok(final);
    assert.equal(final.message.stop_reason, "tool_calls");
    assert.equal(final.message.tool_calls.length, 1);
    assert.equal(final.message.tool_calls[0].name, "write_file");
    assert.equal(final.message.tool_calls[0].arguments, '{"path":"x"}', "arguments ghép từ 2 delta");
    assert.deepEqual(final.usage, { prompt_tokens: 9, completion_tokens: 4 });
  });

  it("client không trả finish_reason -> final undefined, agent fallback non-streaming", async () => {
    const s2 = createServer((req, res) => {
      res.writeHead(200, { Connection: "close" });
      res.end('data: {"choices":[{"delta":{"content":"partial only"}}]}\n\n');
    });
    await new Promise((res) => s2.listen(0, "127.0.0.1", res));
    try {
      const client = makeClient(s2.address().port);
      let final;
      for await (const chunk of client.streamChat([{ role: "user", content: "x" }], [])) {
        if (chunk.done) final = chunk.final;
      }
      assert.equal(final, undefined, "không có finish_reason -> không có final");
    } finally {
      s2.closeAllConnections?.();
      await new Promise((res) => s2.close(res));
    }
  });
});

describe("LlmClient wire format (provider compatibility)", () => {
  let server;
  let port;
  let bodies;

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        bodies.push(JSON.parse(body));
        const wantsStream = JSON.parse(body).stream === true;
        if (wantsStream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
          res.end(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{}"}}]},"finish_reason":null}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          );
        } else {
          res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
          res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
        }
      });
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    port = server.address().port;
  });

  after(() => new Promise((res) => { server.closeAllConnections?.(); server.close(() => res()); }));

  const historyWithToolCall = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: null,
      // Internal shape (như streamChat tích luỹ) — KHÔNG phải wire format
      tool_calls: [{ id: "c1", name: "write_file", arguments: '{"path":"x"}' }],
    },
    { role: "tool", tool_call_id: "c1", name: "write_file", content: "Wrote 1 line" },
  ];

  it("chat(): assistant tool_calls trong history được normalize sang wire format", async () => {
    bodies = [];
    await makeClient(port).chat(historyWithToolCall, []);
    const sent = bodies[0].messages[1];
    assert.equal(sent.tool_calls[0].type, "function", "phải có type=function");
    assert.deepEqual(
      sent.tool_calls[0].function,
      { name: "write_file", arguments: '{"path":"x"}' },
      "tool_call phải bọc trong function={name,arguments}",
    );
    assert.equal(sent.tool_calls[0].name, undefined, "không còn field name ở tầng trên");
  });

  it("streamChat(): history cũng được normalize sang wire format", async () => {
    bodies = [];
    for await (const _chunk of makeClient(port).streamChat(historyWithToolCall, [])) {
      void _chunk;
    }
    const sent = bodies[0].messages[1];
    assert.equal(sent.tool_calls[0].type, "function");
    assert.equal(sent.tool_calls[0].function.name, "write_file");
  });
});

describe("LlmClient error paths", () => {
  it("401 -> LlmError fail-fast (không retry)", async () => {
    const s = createServer((req, res) => {
      res.writeHead(401, { Connection: "close" });
      res.end('{"error":"unauthorized"}');
    });
    await new Promise((res) => s.listen(0, "127.0.0.1", res));
    try {
      await assert.rejects(
        () => makeClient(s.address().port).chat([{ role: "user", content: "x" }], []),
        (err) => err instanceof LlmError && err.status === 401,
      );
    } finally {
      s.closeAllConnections?.();
      await new Promise((res) => s.close(res));
    }
  });

  it("API key trong error body được redact", async () => {
    let server;
    try {
      server = createServer((req, res) => {
        res.writeHead(401, { Connection: "close" });
        res.end('{"error":"Invalid key sk-proj-abcdefgh12345678 provided"}');
      });
      await new Promise((res) => server.listen(0, "127.0.0.1", res));
      let msg = "";
      try {
        await makeClient(server.address().port).chat([{ role: "user", content: "x" }], []);
      } catch (err) {
        msg = err.message;
      }
      assert.ok(!/sk-proj-abcdefgh12345678/.test(msg), "raw key phải bị redact");
      assert.match(msg, /REDACTED/);
    } finally {
      server.closeAllConnections?.();
      await new Promise((res) => server.close(res));
    }
  });
});
