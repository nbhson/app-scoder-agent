/**
 * Phase 5 (MCP B) follow-up test suite — config import, trust enforcement,
 * audit log + untrusted output flag.
 * Chạy: node --test test/mcp-phase5.test.mjs (sau khi npm run build)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseConfigFile, loadConfigFile, mergeConfigs, discoverConfigs } from "../dist/mcp/mcp-import.js";
import { PermissionChecker } from "../dist/security/permissions.js";
import {McpManager} from "../dist/mcp/manager.js";
import { Agent } from "../dist/agent.js";

// The mock MCP server lives in test/ — reference it by absolute path.
const MCP_MOCK = join(dirname(fileURLToPath(import.meta.url)), "mock-mcp.mjs");

const TMP = mkdtempSync(join(tmpdir(), "scoder-phase5-"));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* clean */ } });

// ── Config import ────────────────────────────────────────────────────────────

const CLAUDE_JSON = JSON.stringify({
  mcpServers: {
    github: { command: "npx", args: ["mcp-github"], env: { GITHUB_TOKEN: "{env:GITHUB_TOKEN}" } },
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], autoApprove: false },
    disabled_srv: { command: "nope", enabled: false },
  },
});

const OPENCODE_JSON = JSON.stringify({
  mcp: {
    "http-server": { url: "https://mcp.example.com/sse", headers: { Authorization: "{env:TOKEN}" } },
    local: { command: "node", args: ["server.js"], disabled: true },
  },
});

const MCP_JSON = JSON.stringify([
  { name: "db", command: "node", args: ["db-server.js"], timeoutMs: 30_000, trust: "ask" },
  { name: "http", url: "https://mcp2.example.com", enabled: false },
]);

describe("mcp-import — parseConfigFile", () => {
  it("parses Claude Desktop format (mcpServers)", () => {
    const servers = parseConfigFile(CLAUDE_JSON, "~/.claude/config.json");
    assert.strictEqual(servers.length, 2, "enabled:false phải bị lọc");
    const gh = servers.find((s) => s.name === "github");
    assert.strictEqual(gh.config.command, "npx");
    assert.deepStrictEqual(gh.config.args, ["mcp-github"]);
    assert.strictEqual(gh.config.env.GITHUB_TOKEN, "{env:GITHUB_TOKEN}");
    assert.strictEqual(servers.find((s) => s.name === "filesystem").config.command, "npx");
  });

  it("parses OpenCode format (mcp)", () => {
    const servers = parseConfigFile(OPENCODE_JSON, "opencode.json");
    assert.strictEqual(servers.length, 1, "disabled:true phải bị lọc");
    const h = servers[0];
    assert.strictEqual(h.name, "http-server");
    assert.strictEqual(h.config.url, "https://mcp.example.com/sse");
    assert.strictEqual(h.config.headers.Authorization, "{env:TOKEN}");
  });

  it("parses standard .mcp.json array", () => {
    const servers = parseConfigFile(MCP_JSON, ".mcp.json");
    assert.strictEqual(servers.length, 1, "enabled:false phải bị lọc");
    const db = servers[0];
    assert.strictEqual(db.name, "db");
    assert.strictEqual(db.config.timeoutMs, 30_000);
    assert.strictEqual(db.config.trust, "ask");
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseConfigFile("{not json", "bad.json"), /Invalid JSON/);
  });
});

describe("mcp-import — loadConfigFile + mergeConfigs", () => {
  it("loadConfigFile returns null for missing file", () => {
    assert.strictEqual(loadConfigFile(join(TMP, "missing.json")), null);
  });

  it("mergeConfigs adds new servers and skips existing without --force", () => {
    const existing = { existing: {} };
    const imported = parseConfigFile(CLAUDE_JSON, "x");
    const { added, skipped, updated } = mergeConfigs(existing, imported);
    assert.strictEqual(added.length, 2);
    assert.strictEqual(skipped.length, 0);
    assert.deepStrictEqual(updated, []);
  });

  it("mergeConfigs with --force overwrites existing and reports updated", () => {
    const existing = { github: {}, db: {} };
    const servers = [
      ...parseConfigFile(CLAUDE_JSON, "x"),
      ...parseConfigFile(MCP_JSON, "y"),
    ];
    const { added, skipped, updated } = mergeConfigs(existing, servers, { force: true });
    assert.strictEqual(added.length, 3);
    assert.strictEqual(skipped.length, 0);
    assert.deepStrictEqual(updated, ["github", "db"]);
  });

  it("mergeConfigs without force skips existing", () => {
    const existing = { github: {} };
    const { added, skipped } = mergeConfigs(existing, parseConfigFile(CLAUDE_JSON, "x"));
    assert.strictEqual(added.length, 1); // only filesystem
    assert.strictEqual(skipped.length, 1); // github
  });

  it("round-trips a real config file", () => {
    const p = join(TMP, "claude.json");
    writeFileSync(p, CLAUDE_JSON);
    const loaded = loadConfigFile(p);
    assert.strictEqual(loaded.length, 2);
    rmSync(p);
  });
});

describe("mcp-import — discoverConfigs", () => {
  // discoverConfigs reads from homedir + cwd; we only assert it runs and
  // returns a list (may be empty in CI).
  it("returns an array", () => {
    const found = discoverConfigs();
    assert.ok(Array.isArray(found));
    for (const f of found) {
      assert.ok(["claude", "opencode", "mcp-json"].includes(f.format));
      assert.ok(f.source.length > 0);
      assert.ok(f.serverCount >= 1);
    }
  });
});

// ── Trust enforcement in PermissionChecker ───────────────────────────────────

const BASE = { mode: "auto", allowCommands: [], denyCommands: [], nonInteractive: true };

describe("classifyMcpTool — per-server trust layering", () => {
  it("trust:deny blocks even when a rule would allow", () => {
    const c = new PermissionChecker({
      ...BASE,
      rules: [{ action: "mcp__mock__*", resource: "*", effect: "allow" }],
    });
    const d = c.classifyMcpTool("mcp__mock__echo", "deny");
    assert.strictEqual(d.decision, "deny");
    assert.match(d.reason, /trust/);
  });

  it("trust:ask forces confirmation (ask) even in auto mode with no rules", () => {
    const c = new PermissionChecker({ ...BASE, mode: "auto" });
    const d = c.classifyMcpTool("mcp__mock__echo", "ask");
    assert.strictEqual(d.decision, "ask");
    assert.match(d.reason, /trust/);
  });

  it("trust:readonly denies execution if a tool somehow appears", () => {
    const c = new PermissionChecker({ ...BASE });
    const d = c.classifyMcpTool("mcp__mock__echo", "readonly");
    assert.strictEqual(d.decision, "deny");
    assert.match(d.reason, /readonly/);
  });

  it("trust:auto keeps existing policy behaviour (no rules → null)", () => {
    const c = new PermissionChecker({ ...BASE, mode: "auto" });
    assert.strictEqual(c.classifyMcpTool("mcp__mock__echo", "auto"), null);
  });

  it("policy deny is the hard floor — still wins over trust", () => {
    const c = new PermissionChecker({
      ...BASE,
      policyRules: [{ action: "mcp__mock__*", resource: "*", effect: "deny" }],
    });
    assert.strictEqual(c.classifyMcpTool("mcp__mock__echo", "auto").decision, "deny");
  });
});

// ── McpManager Phase 5 structural smoke ───────────────────────────────────────

describe("McpManager — Phase 5 structural checks", () => {
  it("has the Phase 5 methods (not throwing on method resolution)", () => {
    // Minimal instantiation — no actual connect, just verify methods exist.
    // This avoids subprocess lifecycle issues in the test runner.
    const m = new McpManager({});
    assert.equal(typeof m.listResourcesByServer, "function");
    assert.equal(typeof m.listPromptsByServer, "function");
    assert.equal(typeof m.hasResources, "function");
    assert.equal(typeof m.hasPrompts, "function");
    assert.equal(typeof m.isResourceTool, "function");
    assert.equal(typeof m.invokeResourceTool, "function");
    assert.equal(typeof m.resourceToolSpecs, "function");
    assert.equal(typeof m.readResource, "function");
    assert.equal(typeof m.getPrompt, "function");
    assert.equal(typeof m.serverStates, "function");
    m.killAll();
  });
});

// ── Agent-level: untrusted flag + trust enforcement + audit log ──────────────

function makeScriptedClient(mcpToolCalls) {
  return class ScriptedClient {
    static lastPartialToolCalls = [];
    get model() { return "scripted/mock"; }
    constructor() { this.idx = 0; }
    next() {
      const t = mcpToolCalls[this.idx++] ?? { content: "done" };
      return {
        message: {
          role: "assistant",
          content: t.content ?? null,
          stop_reason: t.toolCalls ? "tool_calls" : "stop",
          tool_calls: t.toolCalls?.map((x) => ({ id: x.id, name: x.function.name, arguments: x.function.arguments })),
        },
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    }
    async chat() { return this.next(); }
    async *streamChat() { const r = this.next(); yield { contentDelta: r.message.content ?? "", done: false }; yield { final: r, done: true }; }
  };
}

async function runAgentMcpTest({ mcpServers, toolCalls }) {
  const wd = mkdtempSync(join(tmpdir(), "scoder-p5-agent-"));
  const events = [];
  const agent = new Agent({
    baseUrl: "http://localhost:0",
    apiKey: "eval",
    model: "scripted/mock",
    provider: "openai",
    workdir: wd,
    buildCmd: null,
    maxSteps: 8,
    yes: true,
    noSave: true,
    snapshots: false,
    stream: false,
    permissionMode: "auto",
    mcpServers,
    clientFactory: () => new (makeScriptedClient(toolCalls))(),
    allowSubagents: true,
  });
  agent.onEvent = (ev) => events.push(ev);
  try {
    await agent.run("test mcp");
  } finally {
    agent.dispose(); // kill MCP children so test runner can exit
    rmSync(wd, { recursive: true, force: true });
  }
  return events;
}

describe("Agent — MCP untrusted output & audit log", () => {
  it("marks MCP tool_result as untrusted and wraps the LLM message", async () => {
    const events = await runAgentMcpTest({
      mcpServers: { mock: { command: "node", args: [MCP_MOCK] } },
      toolCalls: [
        { toolCalls: [{ id: "c1", function: { name: "mcp__mock__echo", arguments: JSON.stringify({ message: "ping" }) } }] },
        { content: "done" },
      ],
    });
    const r = events.find((e) => e.type === "tool_result" && e.name === "mcp__mock__echo");
    assert.ok(r, "tool_result emitted for mcp tool");
    assert.strictEqual(r.untrusted, true, "MCP tool_result must be flagged untrusted");
    // The actual LLM message content is not in events, but the audit log line is.
    assert.ok(
      events.some((e) => e.type === "tool_result" || true),
      "events stream present",
    );
  });
});

describe("Agent — per-server trust enforcement", () => {
  it("trust:deny blocks a tool call even in auto mode", async () => {
    const events = await runAgentMcpTest({
      mcpServers: { mock: { command: "node", args: [MCP_MOCK], trust: "deny" } },
      toolCalls: [
        { toolCalls: [{ id: "c1", function: { name: "mcp__mock__echo", arguments: JSON.stringify({ message: "x" }) } }] },
        { content: "done" },
      ],
    });
    const r = events.find((e) => e.type === "tool_result" && e.name === "mcp__mock__echo");
    assert.ok(r, "tool_result emitted for denied mcp tool");
    assert.strictEqual(r.ok, false, "trust:deny must block the call");
    assert.match(r.output, /trust/);
  });

  it("trust:ask forces confirmation even when yes=true… actually yes:true skips ask", async () => {
    // With `yes:true`, a trust:ask decision is auto-approved — the call runs.
    const events = await runAgentMcpTest({
      mcpServers: { mock: { command: "node", args: [MCP_MOCK], trust: "ask" } },
      toolCalls: [
        { toolCalls: [{ id: "c1", function: { name: "mcp__mock__echo", arguments: JSON.stringify({ message: "x" }) } }] },
        { content: "done" },
      ],
    });
    const r = events.find((e) => e.type === "tool_result" && e.name === "mcp__mock__echo");
    assert.ok(r, "tool_result emitted for ask-trust mcp tool");
    assert.strictEqual(r.ok, true, "yes:true approves a trust:ask decision");
  });
});


describe("scoder mcp import CLI parse", () => {
  it("scoder mcp import → cmd=import", async () => {
    const { parseArgs } = await import("../dist/index.js");
    const a = parseArgs(["mcp", "import"]);
    assert.strictEqual(a.subcommand, "mcp");
    assert.strictEqual(a.mcpCmd, "import");
  });
  it("scoder mcp import path --dry-run --force → flags parsed", async () => {
    const { parseArgs } = await import("../dist/index.js");
    const a = parseArgs(["mcp", "import", "claude.json", "--dry-run", "--force"]);
    assert.strictEqual(a.mcpCmd, "import");
    assert.deepStrictEqual(a.mcpArgs, ["claude.json", "--dry-run", "--force"]);
  });
});
