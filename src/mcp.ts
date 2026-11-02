/**
 * Minimal MCP (Model Context Protocol) client for stdio servers.
 *
 * Implements JSON-RPC 2.0 over stdin/stdout with line-delimited messages.
 * Connects to configured stdio servers, exposes their tools as
 * `mcp__<server>__<tool>` prefixed names in the agent's tool registry.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { CLIENT_NAME, getVersion } from "./version.js";
import { redactSecrets } from "./llm.js";

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

/** M1: connection state — surface qua onState cho AgentEvent mcp_status. */
export type McpConnState = "connecting" | "ready" | "reconnecting" | "dead";

const RECONNECT_MAX = 5;
const RECONNECT_BASE_MS = 500; // backoff: 0.5s, 1s, 2s, 4s, 8s

export class McpConnection {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private buf = "";
  /** Tail of the server's stderr (last 4KB) — surfaced on connect failures. */
  stderrTail = "";
  /** M1: current state machine position. */
  state: McpConnState = "connecting";
  /** M1: status/state sink (AgentEvent mcp_status). */
  onState: ((state: McpConnState, detail: string) => void) | null = null;
  private manuallyClosed = false;
  private reconnectAttempt = 0;

  constructor(
    readonly name: string,
    private cfg: McpServerConfig,
  ) {}

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  private setState(s: McpConnState, detail: string): void {
    this.state = s;
    this.onState?.(s, detail);
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    this.manuallyClosed = false;
    await this.spawnAndHandshake(timeoutMs);
  }

  private async spawnAndHandshake(timeoutMs: number): Promise<void> {
    const p = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...expandEnv(this.cfg.env) },
    });
    this.proc = p;
    p.stderr?.on("data", (c: Buffer) => {
      // Keep the tail for diagnostics (server logs/help output on crash);
      // otherwise stderr is intentionally ignored.
      this.stderrTail = (this.stderrTail + c.toString("utf8")).slice(-4096);
    });

    p.on("error", (e) => this.drain(new Error(`spawn: ${e.message}`)));
    // M1: exit → reconnect với exponential backoff (tối đa 5 lần), trừ khi
    // kill() chủ đích. Pending calls reject rõ ràng ngay lập tức.
    p.on("exit", (code) => {
      this.drain(new Error(`MCP server "${this.name}" process exited (code ${code ?? "?"})`));
      if (this.manuallyClosed) return;
      void this.scheduleReconnect();
    });

    p.stdout?.on("data", (c: Buffer) => this.onChunk(c));

    // MCP handshake: initialize + notifications/initialized
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: getVersion() },
    }, timeoutMs);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.setState("ready", "connected");
  }

  /** M1: exponential backoff reconnect — tools/list refresh do Manager lo. */
  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectAttempt >= RECONNECT_MAX) {
      this.setState("dead", `reconnect failed after ${RECONNECT_MAX} attempts`);
      return;
    }
    this.reconnectAttempt++;
    const delay = RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1);
    this.setState("reconnecting", `attempt ${this.reconnectAttempt}/${RECONNECT_MAX} in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
    if (this.manuallyClosed) return;
    try {
      await this.spawnAndHandshake(15_000);
      this.reconnectAttempt = 0;
      this.setState("ready", "reconnected");
    } catch (e) {
      this.drain(e as Error);
      await this.scheduleReconnect();
    }
  }

  /** M1: health check — ping không có response trong MCP spec stdio → dùng
   *  tools/list với timeout ngắn làm liveness probe. */
  async healthy(timeoutMs = 5_000): Promise<boolean> {
    if (!this.alive) return false;
    try {
      await this.rpc("tools/list", {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
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
    // H-13: MCP servers are third-party — redact secret shapes from output
    // before it enters the conversation or logs.
    return { ok: !isErr, output: redactSecrets(parts.join("\n")) || "(empty result)", structured: res.structuredContent };
  }

  kill(): void {
    this.manuallyClosed = true;
    this.setState("dead", "closed by client");
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
  /** Status sink (default console.error; the TUI routes it to a notice). */
  onStatus: ((line: string) => void) | null = null;

  constructor(private configs: Record<string, McpServerConfig>) {}

  /** Connect all servers; skip failures with a warning. Returns discovered tool count. */
  async connectAll(): Promise<number> {
    await Promise.allSettled(
      Object.entries(this.configs).map(async ([name, cfg]) => {
        const conn = new McpConnection(name, cfg);
        this.wireReconnect(name, conn);
        await conn.connect();
        await this.registerTools(name, conn);
        this.conns.set(name, conn);
      }),
    ).then((results) => {
      const report = this.onStatus ?? ((line: string) => console.error(line));
      results.forEach((r, i) => {
        const name = Object.keys(this.configs)[i];
        if (r.status === "rejected") {
          report(`⚠  MCP server "${name}" unavailable: ${String((r.reason as Error)?.message).slice(0, 160)}`);
        } else {
          const n = [...this.tools.values()].filter((t) => t.serverName === name).length;
          report(`✓ MCP "${name}" connected — ${n} tool${n === 1 ? "" : "s"}`);
        }
      });
    });
    return this.tools.size;
  }

  /** M1: surface connection state machine + refresh tools sau reconnect. */
  private wireReconnect(name: string, conn: McpConnection): void {
    conn.onState = (state, detail) => {
      const report = this.onStatus ?? ((line: string) => console.error(line));
      if (state === "reconnecting") report(`⚠  MCP "${name}" ${detail}`);
      if (state === "dead") report(`✘ MCP "${name}" dead: ${detail}`);
      if (state === "ready" && detail === "reconnected") {
        report(`✓ MCP "${name}" reconnected`);
        // Refresh tool list — server có thể đăng ký bộ tool mới.
        conn
          .listTools()
          .then((defs) => this.reregisterTools(name, conn, defs))
          .catch(() => {});
      }
    };
  }

  private async registerTools(name: string, conn: McpConnection): Promise<void> {
    const defs = await conn.listTools();
    this.reregisterTools(name, conn, defs);
  }

  /** Replace một server's tool registrations (reconnect refresh). */
  private reregisterTools(name: string, conn: McpConnection, defs: McpTool[]): void {
    for (const [key, t] of [...this.tools]) {
      if (t.serverName === name) this.tools.delete(key);
    }
    for (const def of defs) {
      const key = mcpToolKey(name, def.name);
      this.tools.set(key, { conn, serverName: name, toolName: def.name, def });
    }
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
