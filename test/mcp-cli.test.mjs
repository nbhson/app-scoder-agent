/**
 * Phase 5 (MCP B) test suite — scoder mcp CLI, enabled/trust no-spawn, config import.
 * Chạy: node --test test/mcp-cli.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../dist/index.js";

describe("scoder mcp CLI parse", () => {
  // parseArgs receives process.argv.slice(2) so first two elements (node/script) are absent.
  it("scoder mcp → subcommand=mcp, cmd=list", () => {
    const a = parseArgs(["mcp"]);
    assert.strictEqual(a.subcommand, "mcp");
    assert.strictEqual(a.mcpCmd, "list");
  });

  it("scoder mcp list → cmd=list", () => {
    const a = parseArgs(["mcp", "list"]);
    assert.strictEqual(a.subcommand, "mcp");
    assert.strictEqual(a.mcpCmd, "list");
  });

  it("scoder mcp add github --command 'npx mcp-github' → cmd=add, name=github", () => {
    const a = parseArgs(["mcp", "add", "github", "--command", "npx mcp-github"]);
    assert.strictEqual(a.subcommand, "mcp");
    assert.strictEqual(a.mcpCmd, "add");
    assert.deepStrictEqual(a.mcpArgs, ["github", "--command", "npx mcp-github"]);
  });

  it("scoder mcp remove github → cmd=remove, name=github", () => {
    const a = parseArgs(["mcp", "remove", "github"]);
    assert.strictEqual(a.subcommand, "mcp");
    assert.strictEqual(a.mcpCmd, "remove");
    assert.deepStrictEqual(a.mcpArgs, ["github"]);
  });

  it("scoder mcp test github → cmd=test, name=github", () => {
    const a = parseArgs(["mcp", "test", "github"]);
    assert.strictEqual(a.subcommand, "mcp");
    assert.strictEqual(a.mcpCmd, "test");
    assert.deepStrictEqual(a.mcpArgs, ["github"]);
  });

  it("scoder mcp add gh --command npx --trust readonly → trust flag passed", () => {
    const a = parseArgs(["mcp", "add", "gh", "--command", "npx", "--trust", "readonly"]);
    assert.strictEqual(a.mcpCmd, "add");
    assert.deepStrictEqual(a.mcpArgs, ["gh", "--command", "npx", "--trust", "readonly"]);
  });
});

// ── McpManager enabled/trust no-spawn ───────────────────────────────────────

describe("McpManager — enabled:false / trust:readonly no-spawn", () => {
  it("enabled:false server is skipped (not spawned), reported as disabled", async () => {
    const { McpManager } = await import("../dist/mcp.js");
    const m = new McpManager({ disabledSrv: { command: "node", args: ["nonexistent"], enabled: false } });
    const statusLines = [];
    m.onStatus = (l) => statusLines.push(l);
    await m.connectAll();
    assert.ok(!m.hasTool("mcp__disabledSrv__echo"), "no tools registered for disabled server");
    assert.ok(statusLines.some((l) => l.includes("disabled") || l.includes("skipped")), `got status: ${statusLines.join("; ")}`);
    m.killAll();
  });

  it("trust:readonly server is skipped (not spawned), reported as readonly", async () => {
    const { McpManager } = await import("../dist/mcp.js");
    const m = new McpManager({ roSrv: { command: "node", args: ["nonexistent"], trust: "readonly" } });
    const statusLines = [];
    m.onStatus = (l) => statusLines.push(l);
    await m.connectAll();
    assert.ok(!m.hasTool("mcp__roSrv__echo"), "no tools registered for readonly server");
    assert.ok(statusLines.some((l) => l.includes("readonly") || l.includes("skipped")), `got status: ${statusLines.join("; ")}`);
    m.killAll();
  });
});
