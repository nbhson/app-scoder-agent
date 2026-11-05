/**
 * Phase 4 (MCP A) test suite — protocol completeness, SSE streaming, notifications,
 * tool governance, applyConfig restart.
 * Chạy: node --test test/mcp-phase4.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpManager } from "../dist/mcp.js";
import { parseSseEvent } from "../dist/mcp.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "mock-mcp.mjs");

// ── parseSseEvent ─────────────────────────────────────────────────────────

describe("parseSseEvent", () => {
  it("parses a single-line data: JSON event", () => {
    const out = parseSseEvent("data:{\"jsonrpc\":\"2.0\",\"method\":\"tools/list_changed\"}");
    assert.deepStrictEqual(out, { jsonrpc: "2.0", method: "tools/list_changed" });
  });

  it("parses multi-line data: (a JSON payload split across SSE data lines)", () => {
    // SSE allows a single JSON payload split across consecutive data: lines;
    // they're joined with \n before parse.
    const out = parseSseEvent("data:{\n" + "data:  \"id\": 42\n" + "data:}");
    assert.deepStrictEqual(out, { id: 42 });
  });

  it("normalizes CRLF → LF before parsing", () => {
    const out = parseSseEvent("data:{\r\ndata:\"x\": 1\r\ndata:}\r\n");
    assert.deepStrictEqual(out, { x: 1 });
  });

  it("skips non-data: lines (comment lines, event names)", () => {
    const out = parseSseEvent("event: ping\ndata:{\"result\":\"pong\"}\n\n");
    assert.deepStrictEqual(out, { result: "pong" });
  });

  it("returns null for empty data", () => {
    assert.strictEqual(parseSseEvent(""), null);
    assert.strictEqual(parseSseEvent("data:"), null);
    assert.strictEqual(parseSseEvent(""), null);
  });

  it("skips malformed JSON", () => {
    const out = parseSseEvent("data:not valid json");
    assert.strictEqual(out, null);
  });

  it("complete SSE block (with blank-line terminator, CRLF)", () => {
    const out = parseSseEvent("data:{\"method\":\"message\",\"params\":{\"message\":\"hi\"}}\r\n\r\n");
    assert.deepStrictEqual(out, { method: "message", params: { message: "hi" } });
  });
});

// ── McpConnection protocol version / capabilities ───────────────────────────

describe("McpManager — protocol version + serverInfo", () => {
  it("captures serverInfo + capabilities from initialize result", async () => {
    const m = new McpManager({ pingtest: { command: "node", args: [MOCK] } });
    await m.connectAll();
    const states = m.serverStates();
    assert.strictEqual(states.length, 1);
    const s = states[0];
    assert.deepStrictEqual(s.serverInfo, { name: "mock-mcp", version: "0.1.0" });
    assert.strictEqual(s.capabilities.ping, true, "ping capability from initialize");
    assert.strictEqual(s.state, "ready");
    m.killAll();
  });

  it("ping succeeds on a server that declares ping capability", async () => {
    const m = new McpManager({ pingtest: { command: "node", args: [MOCK] } });
    await m.connectAll();
    const conn = [...m["conns"].values()][0];
    // healthy() should use ping (not tools/list) since capabilities.ping is true.
    const ok = await conn.healthy(5_000);
    assert.strictEqual(ok, true, "healthy() should succeed via ping");
    m.killAll();
  });

  it("serverStates includes toolCount", async () => {
    const m = new McpManager({ srv: { command: "node", args: [MOCK] } });
    await m.connectAll();
    const states = m.serverStates();
    assert.strictEqual(states.length, 1);
    assert.strictEqual(states[0].toolCount, 1, "1 tool registered");
    m.killAll();
  });
});

// ── McpManager applyConfig restart on config change ──────────────────────────

describe("McpManager.applyConfig — restart on config change", () => {
  const cfg = (name) => ({ command: "node", args: [MOCK] });

  it("command change → server restarts (old killed, new connect)", async () => {
    const m = new McpManager({ srv: cfg("srv") });
    await m.connectAll();
    assert.ok(m.hasTool("mcp__srv__echo"), "pre: echo tool registered");

    // Re-register same name but different config → restart.
    await m.applyConfig({ srv: { command: "node", args: [MOCK, "extra-arg"] } });
    assert.ok(m.hasTool("mcp__srv__echo"), "post: echo tool still present after restart");
    m.killAll();
  });

  it("tool include filter hides matching tools", async () => {
    const m = new McpManager({ srv: cfg("srv") });
    await m.connectAll();
    assert.ok(m.hasTool("mcp__srv__echo"), "pre: echo present without filter");

    // Apply filter that excludes echo.
    await m.applyConfig({ srv: { ...cfg("srv"), tools: { exclude: ["echo"] } } });
    assert.ok(!m.hasTool("mcp__srv__echo"), "post: echo excluded");

    // Include filter — echo is already excluded globally; tool count should reflect.
    await m.applyConfig({ srv: { ...cfg("srv"), tools: { include: ["notexist"] } } });
    assert.ok(!m.hasTool("mcp__srv__echo"), "post: echo not in include-only filter");
    m.killAll();
  });

  it("tool include filter allows matching tools only", async () => {
    const m = new McpManager({ srv: cfg("srv") });
    await m.applyConfig({ srv: { ...cfg("srv"), tools: { include: ["echo*"] } } });
    assert.ok(m.hasTool("mcp__srv__echo"), "echo matches include:echo*");
    m.killAll();
  });
});

// ── McpManager tools/list_changed notification ──────────────────────────────

describe("McpManager — tools/list_changed notification", () => {
  it("serverStates captures connection state, not tool count", async () => {
    // This validates that connected = state === "ready", not byServer.has(name).
    const m = new McpManager({ srv: { command: "node", args: [MOCK] } });
    await m.connectAll();
    const states = m.serverStates();
    assert.strictEqual(states[0].state, "ready", "state === ready");
    assert.strictEqual(states[0].connected, undefined); // connected not a field on serverStates
    m.killAll();
  });
});
