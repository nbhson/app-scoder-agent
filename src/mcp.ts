/**
 * Minimal MCP (Model Context Protocol) client.
 *
 * M3: pluggable transport — `StdioTransport` (JSON-RPC 2.0 over stdin/stdout,
 * line-delimited) và `HttpTransport` (Streamable HTTP: POST JSON-RPC, nhận
 * JSON hoặc SSE stream, echo `Mcp-Session-Id`). Config `url` → http, ngược
 * lại → stdio. Exposes discovered tools as `mcp__<server>__<tool>` prefixed
 * names in the agent's tool registry.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { CLIENT_NAME, getVersion } from "./version.js";
import { redactSecrets } from "./llm.js";

export interface McpServerConfig {
  /** stdio: command to spawn (mặc định khi không có url). */
  command?: string;
  args?: string[];
  /** Supports {env:VAR} substitution — never hardcode secrets in config */
  env?: Record<string, string>;
  /** M3: HTTP transport — URL của MCP endpoint (Streamable HTTP). */
  url?: string;
  /** M3: headers cho HTTP transport (auth token qua {env:VAR} substitution). */
  headers?: Record<string, string>;
  /** M3: override loại transport; mặc định suy ra từ url/command. */
  type?: "stdio" | "http";
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

// ── Transport abstraction (M3) ───────────────────────────────────────────────

/** A JSON-RPC message channel to one MCP server. */
export interface McpTransport {
  readonly kind: "stdio" | "http";
  /** Channel usable for send()? */
  readonly alive: boolean;
  /** Establish the channel (spawn process / reset session state). */
  start(): Promise<void>;
  /** Send one JSON-RPC message. HTTP: resolves khi response đã được parse. */
  send(msg: object): Promise<void>;
  /** Inbound JSON-RPC messages (responses + server notifications). */
  onMessage(cb: (msg: Record<string, unknown>) => void): void;
  /** Channel died irrecoverably (process exit). HTTP: không dùng (stateless). */
  onDown(cb: (err: Error) => void): void;
  close(): void;
}

/** stdio transport — spawn process, line-delimited JSON-RPC trên stdin/stdout. */
export class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;
  proc: ChildProcess | null = null;
  /** Tail of the server's stderr (last 4KB) — surfaced on connect failures. */
  stderrTail = "";
  private buf = "";
  private msgCb: ((msg: Record<string, unknown>) => void) | null = null;
  private downCb: ((err: Error) => void) | null = null;

  constructor(private cfg: McpServerConfig) {}

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  onMessage(cb: (msg: Record<string, unknown>) => void): void {
    this.msgCb = cb;
  }

  onDown(cb: (err: Error) => void): void {
    this.downCb = cb;
  }

  async start(): Promise<void> {
    const command = this.cfg.command;
    if (!command) throw new Error("MCP stdio transport requires \"command\" in the server config");
    const p = spawn(command, this.cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...expandEnv(this.cfg.env) },
      // Windows: npx/foo.cmd chỉ spawn được qua shell (libuv không tự tìm .cmd).
      shell: process.platform === "win32",
    });
    this.proc = p;
    p.stderr?.on("data", (c: Buffer) => {
      // Keep the tail for diagnostics (server logs/help output on crash);
      // otherwise stderr is intentionally ignored.
      this.stderrTail = (this.stderrTail + c.toString("utf8")).slice(-4096);
    });
    p.on("error", (e) => this.downCb?.(new Error(`spawn: ${e.message}`)));
    p.on("exit", (code) => this.downCb?.(new Error(`process exited (code ${code ?? "?"})`)));
    p.stdout?.on("data", (c: Buffer) => this.onChunk(c));
  }

  send(msg: object): Promise<void> {
    if (!this.proc?.stdin?.writable) return Promise.resolve();
    try { this.proc.stdin.write(JSON.stringify(msg) + "\n"); } catch { /* ignore */ }
    return Promise.resolve();
  }

  close(): void {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* already dead */ }
      this.proc = null;
    }
  }

  private onChunk(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try { this.msgCb?.(JSON.parse(line) as Record<string, unknown>); } catch { /* skip malformed */ }
    }
  }
}

/**
 * M3: Streamable HTTP transport — POST một JSON-RPC message, server trả về
 * `application/json` (single response) hoặc `text/event-stream` (SSE; parse
 * các `data:` events). Echo `Mcp-Session-Id` từ initialize trên các request
 * sau. Stateless: lỗi request → reject call hiện tại; call sau tự retry
 * (không cần background reconnect như stdio).
 */
export class HttpTransport implements McpTransport {
  readonly kind = "http" as const;
  private sessionId: string | null = null;
  private msgCb: ((msg: Record<string, unknown>) => void) | null = null;
  private closed = false;

  constructor(private cfg: McpServerConfig) {}

  get alive(): boolean {
    return !this.closed;
  }

  onMessage(cb: (msg: Record<string, unknown>) => void): void {
    this.msgCb = cb;
  }

  onDown(_cb: (err: Error) => void): void {
    // HTTP là stateless — không có channel chết để báo.
  }

  async start(): Promise<void> {
    this.closed = false;
  }

  async send(msg: object): Promise<void> {
    if (this.closed) throw new Error(`MCP HTTP transport "${this.cfg.url}" closed`);
    const res = await this.post(msg, this.sessionId);
    // Session expired (server restart) → thử lại một lần không session.
    if ((res.status === 404 || res.status === 400) && this.sessionId) {
      this.sessionId = null;
      const retry = await this.post(msg, null);
      return this.consume(retry);
    }
    return this.consume(res);
  }

  close(): void {
    this.closed = true;
    this.sessionId = null;
  }

  private async post(msg: object, sessionId: string | null): Promise<Response> {
    const url = this.cfg.url;
    if (!url) throw new Error("MCP HTTP transport requires \"url\" in the server config");
    // M3: headers hỗ trợ {env:VAR} substitution như env — không hardcode secrets.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...expandEnv(this.cfg.headers),
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    try {
      return await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new Error(`MCP HTTP "${url}": ${(e as Error).message}`, { cause: e });
    }
  }

  private async consume(res: Response): Promise<void> {
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new Error(`MCP HTTP ${res.status} ${res.statusText}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      const text = await res.text();
      for (const m of parseSseMessages(text)) this.msgCb?.(m);
    } else if (ct.includes("application/json")) {
      const body = (await res.text()).trim();
      if (body) {
        try { this.msgCb?.(JSON.parse(body) as Record<string, unknown>); } catch { /* skip malformed */ }
      }
    } // 202/no-content (notifications) — nothing to parse
  }
}

/** Parse SSE text thành JSON-RPC messages (concat các dòng `data:` liên tiếp). */
export function parseSseMessages(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try { out.push(JSON.parse(data) as Record<string, unknown>); } catch { /* skip malformed */ }
  }
  return out;
}

// ── JSON-RPC connection ──────────────────────────────────────────────────────

/** M1: connection state — surface qua onState cho AgentEvent mcp_status. */
export type McpConnState = "connecting" | "ready" | "reconnecting" | "dead";

const RECONNECT_MAX = 5;
const RECONNECT_BASE_MS = 500; // backoff: 0.5s, 1s, 2s, 4s, 8s

export class McpConnection {
  private transport: McpTransport;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  /** M1: current state machine position. */
  state: McpConnState = "connecting";
  /** M1: status/state sink (AgentEvent mcp_status). */
  onState: ((state: McpConnState, detail: string) => void) | null = null;
  private manuallyClosed = false;
  private reconnectAttempt = 0;

  constructor(
    readonly name: string,
    private cfg: McpServerConfig,
  ) {
    // M3: url → HTTP transport; ngược lại stdio (default).
    const kind = cfg.type ?? (cfg.url ? "http" : "stdio");
    if (kind === "http" && !cfg.url) throw new Error(`MCP server "${name}": type "http" nhưng thiếu url`);
    if (kind === "stdio" && !cfg.command) throw new Error(`MCP server "${name}": thiếu command`);
    this.transport = kind === "http" ? new HttpTransport(cfg) : new StdioTransport(cfg);
  }

  /** stdio process (null với HTTP) — dùng trong tests. */
  get proc(): ChildProcess | null {
    return this.transport.kind === "stdio" ? (this.transport as StdioTransport).proc : null;
  }

  get stderrTail(): string {
    return this.transport.kind === "stdio" ? (this.transport as StdioTransport).stderrTail : "";
  }

  get alive(): boolean {
    return this.transport.alive;
  }

  private setState(s: McpConnState, detail: string): void {
    this.state = s;
    this.onState?.(s, detail);
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    this.manuallyClosed = false;
    await this.startAndHandshake(timeoutMs);
  }

  private async startAndHandshake(timeoutMs: number): Promise<void> {
    await this.transport.start();
    this.wireTransport();
    // MCP handshake: initialize + notifications/initialized
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: getVersion() },
    }, timeoutMs);
    void this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {
      // notification — không có pending để reject; lỗi sẽ lộ ở call sau.
    });
    this.setState("ready", "connected");
  }

  /** Wire inbound messages + channel-death → reconnect (stdio only). */
  private wireTransport(): void {
    this.transport.onMessage((msg) => {
      if (msg.id === undefined) return; // notification — nothing pending
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);
      const err = msg.error as { code: number; message: string } | undefined;
      if (err) pending.reject(new Error(`${err.code}: ${err.message}`));
      else pending.resolve((msg.result ?? {}) as Record<string, unknown>);
    });
    if (this.transport.kind === "stdio") {
      this.transport.onDown((err) => {
        // M1: exit → drain pending (reject rõ ràng) → reconnect, trừ khi
        // kill() chủ đích.
        this.drain(new Error(`MCP server "${this.name}" ${err.message}`));
        if (this.manuallyClosed) return;
        void this.scheduleReconnect();
      });
    }
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
      await this.startAndHandshake(15_000);
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
    this.transport.close();
  }

  // ── internals ─────────────────────────────────────────────────────────────

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
      void Promise.resolve(this.transport.send({ jsonrpc: "2.0", id, method, params })).catch((e) => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.reject(e as Error);
        }
      });
    });
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
  /** Sidebar TUI: máy trạng thái per-server (connecting/ready/reconnecting/dead). */
  onServerState: ((name: string, state: McpConnState, detail: string) => void) | null = null;

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
          this.onServerState?.(name, "dead", "connect failed");
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
      // Sidebar TUI: structured state trước — mọi transition đều thú vị với
      // map mcpServers, còn chat notice chỉ với reconnect/dead/ready (dưới).
      this.onServerState?.(name, state, detail);
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
    this.tools.clear();
  }

  /** M4: config hot-reload — connect server mới, kill server đã bị xóa khỏi config. */
  async applyConfig(configs: Record<string, McpServerConfig>): Promise<void> {
    this.configs = configs;
    // Server bị xóa → kill + unregister.
    for (const [name, conn] of [...this.conns]) {
      if (!configs[name]) {
        conn.kill();
        this.conns.delete(name);
        for (const [key, t] of [...this.tools]) {
          if (t.serverName === name) this.tools.delete(key);
        }
        const report = this.onStatus ?? ((line: string) => console.error(line));
        report(`✘ MCP "${name}" removed (config changed)`);
      }
    }
    // Server mới → connect.
    for (const [name, cfg] of Object.entries(configs)) {
      if (this.conns.has(name)) continue;
      const conn = new McpConnection(name, cfg);
      this.wireReconnect(name, conn);
      try {
        await conn.connect();
        await this.registerTools(name, conn);
        this.conns.set(name, conn);
        const report = this.onStatus ?? ((line: string) => console.error(line));
        const n = [...this.tools.values()].filter((t) => t.serverName === name).length;
        report(`✓ MCP "${name}" connected — ${n} tool${n === 1 ? "" : "s"} (hot-reload)`);
      } catch (e) {
        const report = this.onStatus ?? ((line: string) => console.error(line));
        report(`⚠  MCP server "${name}" unavailable: ${String((e as Error).message).slice(0, 160)}`);
      }
    }
  }
}
