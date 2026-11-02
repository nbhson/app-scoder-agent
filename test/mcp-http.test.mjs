/**
 * M3: MCP HTTP transport — mock Streamable HTTP server, handshake (SSE
 * response), tools/list, tools/call, session-id echo, header pass-through.
 * Chạy: node --test test/mcp-http.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpConnection, McpManager, parseSseMessages } from "../dist/mcp.js";
import { startMockMcpHttp } from "./mock-mcp-http.mjs";

describe("M3 — parseSseMessages", () => {
  it("parse data: events, bỏ comment/event name", () => {
    const msgs = parseSseMessages(
      ': ping\nevent: message\ndata: {"id":1,"result":{"ok":true}}\n\ndata: {"id":2}\n\nkhông phải data\n',
    );
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].id, 1);
    assert.deepEqual(msgs[0].result, { ok: true });
    assert.equal(msgs[1].id, 2);
  });
});

describe("M3 — McpConnection over HTTP", () => {
  it("handshake (SSE) + tools/list + tools/call + session echo + headers", async () => {
    const { server, seen, url } = await startMockMcpHttp();
    const c = new McpConnection("http-mock", {
      url,
      headers: { authorization: "Bearer {env:TEST_TOKEN}" },
    });
    process.env.TEST_TOKEN = "tok-123";
    await c.connect();
    assert.equal(c.state, "ready");
    assert.equal(c.alive, true);

    const tools = await c.listTools(5_000);
    assert.deepEqual(tools.map((t) => t.name), ["echo"]);

    const r = await c.callTool("echo", { message: "hello http" }, 5_000);
    assert.equal(r.ok, true);
    assert.equal(r.output, "ECHO: hello http");

    // session-id echo: initialized (202) + tools/list + tools/call đều mang header.
    assert.equal(seen.sessionEchoed, 3, `session echo count=${seen.sessionEchoed}`);
    // header pass-through + {env:VAR} expansion
    assert.equal(seen.authHeader, "Bearer tok-123");

    c.kill();
    assert.equal(c.state, "dead");
    server.close();
  });

  it("server chết → callTool reject rõ ràng, healthy() false", async () => {
    const { server, url } = await startMockMcpHttp();
    const c = new McpConnection("h", { url });
    await c.connect();
    server.close();
    await assert.rejects(() => c.listTools(3_000), /ECONNREFUSED|fetch failed|HTTP/);
    assert.equal(await c.healthy(3_000), false);
    c.kill();
  });
});

describe("M3 — McpManager với HTTP server", () => {
  it("connectAll → tool spec mcp__<name>__echo", async () => {
    const { server, url } = await startMockMcpHttp();
    const m = new McpManager({ web: { url } });
    const n = await m.connectAll();
    assert.equal(n, 1);
    assert.ok(m.hasTool("mcp__web__echo"));
    const specs = m.toToolSpecs();
    assert.equal(specs[0].function.name, "mcp__web__echo");
    m.killAll();
    server.close();
  });
});
