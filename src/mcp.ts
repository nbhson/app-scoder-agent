/**
 * Minimal MCP (Model Context Protocol) client for stdio servers.
 *
 * Implements JSON-RPC 2.0 over stdin/stdout with line-delimited messages.
 * Connects to configured stdio servers, exposes their tools as
 * `mcp__<server>__<tool>` prefixed names in the agent's tool registry.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { CLIENT_NAME, getVersion } from "./version.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  /** Supports {env:VAR} substitution — never hardcode secrets in config */
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export const MCP_TOOL_PREFIX = "mcp__";

export function mcpToolKey(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

/** Expand {env:VAR} references in config env values. */
function expandEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = v.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? "");
  }
  return out;
}

// ── JSON-RPC stdio connection ─────────────────────────────────────────────────

export class McpConnection {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private buf = "";

  constructor(
    readonly name: string,
    private cfg: McpServerConfig,
  ) {}

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    const p = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...expandEnv(this.cfg.env) },
    });
    this.proc = p;
    p.stderr?.on("data", () => { /* server diagnostics — ignore */ });

    p.on("error", (e) => this.drain(new Error(`spawn: ${e.message}`)));
    p.on("exit", () => this.drain(new Error("process exited")));

    p.stdout?.on("data", (c: Buffer) => this.onChunk(c));

    // MCP handshake: initialize + notifications/initialized
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: getVersion() },
    }, timeoutMs);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(timeoutMs = 120_000): Promise<McpTool[]> {
    const res = await this.rpc("tools/list", {}, timeoutMs) as { tools?: McpTool[] };
    return (res.tools ?? []).filter((t): t is McpTool => typeof t.name === "string");
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<{ ok: boolean; output: string; structured?: Record<string, unknown> }> {
    const res = await this.rpc("tools/call", { name, arguments: args }, timeoutMs) as {
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    const isErr = res.isError === true;
    const parts = (res.content ?? []).map((c) => c.text ?? "").filter(Boolean);
    return { ok: !isErr, output: parts.join("\n") || "(empty result)", structured: res.structuredContent };
  }

  kill(): void {
    this.drain(new Error("disconnected"));
    if (this.proc) {
      try { this.proc.kill(); } catch { /* already dead */ }
      this.proc = null;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private send(msg: object): void {
    if (!this.proc?.stdin?.writable) return;
    try { this.proc.stdin.write(JSON.stringify(msg) + "\n"); } catch { /* ignore */ }
  }

  private async rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.alive) throw new Error(`MCP server "${this.name}" not connected`);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${method}" timed out after ${(timeoutMs / 1000).toFixed(0)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onChunk(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };
      try { msg = JSON.parse(line) as typeof msg; } catch { continue; }
      if (msg.id === undefined) continue;
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else pending.resolve(msg.result ?? {});
    }
  }

  private drain(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}

// ── Manager: multi-server registry ─────────────────────────────────────────

export interface RegisteredMcpTool {
  conn: McpConnection;
  serverName: string;
  toolName: string;
  def: McpTool;
}

export class McpManager {
  private conns = new Map<string, McpConnection>();
  private tools = new Map<string, RegisteredMcpTool>();

  constructor(private configs: Record<string, McpServerConfig>) {}

  /** Connect all servers; skip failures with a warning. Returns discovered tool count. */
  async connectAll(): Promise<number> {
    await Promise.allSettled(
      Object.entries(this.configs).map(async ([name, cfg]) => {
        const conn = new McpConnection(name, cfg);
        await conn.connect();
        const defs = await conn.listTools();
        for (const def of defs) {
          const key = mcpToolKey(name, def.name);
          if (this.tools.has(key)) throw new Error(`Duplicate MCP tool: ${key}`);
          this.tools.set(key, { conn, serverName: name, toolName: def.name, def });
        }
        this.conns.set(name, conn);
      }),
    ).then((results) => {
      results.forEach((r, i) => {
        const name = Object.keys(this.configs)[i];
        if (r.status === "rejected") {
          console.error(`⚠  MCP server "${name}" unavailable: ${String((r.reason as Error)?.message).slice(0, 160)}`);
        } else {
          const n = [...this.tools.values()].filter((t) => t.serverName === name).length;
          console.error(`✓ MCP "${name}" connected — ${n} tool${n === 1 ? "" : "s"}`);
        }
      });
    });
    return this.tools.size;
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /** Per-server tool listing (for /mcp status display). */
  listToolsByServer(): Array<{ server: string; tools: McpTool[] }> {
    const map = new Map<string, McpTool[]>();
    for (const t of this.tools.values()) {
      const arr = map.get(t.serverName) ?? [];
      arr.push({ name: t.toolName, description: t.def.description, inputSchema: t.def.inputSchema });
      map.set(t.serverName, arr);
    }
    return [...map.entries()].map(([server, tools]) => ({ server, tools }));
  }

  getTool(name: string): RegisteredMcpTool | undefined {
    return this.tools.get(name);
  }

  /** Convert all discovered MCP tools to OpenAI function-calling specs. */
  toToolSpecs(): import("./llm.js").ToolSpec[] {
    return [...this.tools.values()].map(({ conn: _, serverName, toolName, def }) => ({
      type: "function" as const,
      function: {
        name: mcpToolKey(serverName, toolName),
        description: def.description ?? `MCP tool "${toolName}" from server "${serverName}"`,
        parameters: def.inputSchema ?? { type: "object", properties: {} },
      },
    }));
  }

  killAll(): void {
    for (const c of this.conns.values()) c.kill();
    this.conns.clear();
  }
}
