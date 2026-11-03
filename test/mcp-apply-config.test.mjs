/**
 * M4: McpManager.applyConfig — server mới connect, server xóa kill/unregister.
 * Dùng mock-mcp server thật (2 instance, cổng khác nhau qua file path).
 * Chạy: node --test test/mcp-apply-config.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpManager } from "../dist/mcp.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "mock-mcp.mjs");
const cfg = (name) => ({ command: "node", args: [MOCK] });

describe("M4 — McpManager.applyConfig", () => {
  it("server mới → connect + register; server xóa → unregister", async () => {
    const m = new McpManager({ alpha: cfg("alpha") });
    const n0 = await m.connectAll();
    assert.equal(n0, 1);
    assert.ok(m.hasTool("mcp__alpha__echo"));

    // Thêm beta + xóa alpha.
    await m.applyConfig({ beta: cfg("beta") });
    assert.ok(!m.hasTool("mcp__alpha__echo"), "alpha bị unregister");
    assert.ok(m.hasTool("mcp__beta__echo"), "beta được register");
    const specs = m.toToolSpecs();
    assert.equal(specs.length, 1);
    assert.equal(specs[0].function.name, "mcp__beta__echo");
    m.killAll();
  });

  it("server giữ nguyên → không reconnect (tool vẫn dùng được)", async () => {
    const m = new McpManager({ keep: cfg("keep") });
    await m.connectAll();
    await m.applyConfig({ keep: cfg("keep") });
    const reg = m.getTool("mcp__keep__echo");
    const r = await reg.conn.callTool("echo", { message: "still" });
    assert.equal(r.ok, true);
    m.killAll();
  });
});
