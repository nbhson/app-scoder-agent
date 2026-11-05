/**
 * Minimal MCP (Model Context Protocol) client.
 *
 * M3: pluggable transport — `StdioTransport` (JSON-RPC 2.0 over stdin/stdout,
 * line-delimited) và `HttpTransport` (Streamable HTTP: POST JSON-RPC, nhận
 * JSON hoặc SSE stream, echo `Mcp-Session-Id`). Config `url` → http, ngược
 * lại → stdio. Exposes discovered tools as `mcp__<server>__<tool>` prefixed
 * names in the agent's tool registry.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { CLIENT_NAME, getVersion } from "./version.js";
import { redactSecrets, type ToolSpec } from "./llm.js";

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
  /** MCP A: per-server tool governance — include/exclude filters. */
  tools?: { include?: string[]; exclude?: string[] };
  /** MCP A: request timeout (ms) — override default 120s. */
  timeoutMs?: number;
  /** MCP B: whether to connect this server at all (default true). */
  enabled?: boolean;
  /** MCP B: permission mode for this server's tools. Defaults to "auto" (use global mode). */
  trust?: "auto" | "ask" | "readonly" | "deny";
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** MCP resources (Phase 4) — read-only data a server exposes by URI. */
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri?: string;
  mimeType?: string;
  text?: string;
  /** base64 payload for binary resources (never sent to the LLM verbatim). */
  blob?: string;
}

/** MCP prompts (Phase 4) — server-provided prompt templates. */
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
  role?: string;
  content?: unknown;
}

export const MCP_TOOL_PREFIX = "mcp__";

export function mcpToolKey(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

/** Phase 4: generic MCP resource/prompt tools (advertised only when available). */
export const MCP_RESOURCE_TOOL_NAMES = new Set([
  "mcp_list_resources",
  "mcp_read_resource",
  "mcp_list_prompts",
  "mcp_get_prompt",
]);

const schemaObj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const strProp = (description: string) => ({ type: "string", description });
const boolProp = (description: string) => ({ type: "boolean", description });

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
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    // Release pipe handles so the parent process can exit immediately.
    // On Windows shell:true (cmd.exe wrapper), p.kill() only kills cmd.exe —
    // the real node child is orphaned and keeps stdout open. Use taskkill /T
    // to kill the whole process tree; this also works for the plain node case.
    try { p.stdin?.end(); } catch { /* ignore */ }
    try { p.stdout?.destroy(); } catch { /* ignore */ }
    try { p.stderr?.destroy(); } catch { /* ignore */ }
    try { p.kill(); } catch { /* ignore */ }
    if (process.platform === "win32" && p.pid) {
      // Fire-and-forget; ignore errors — process may already be gone.
      spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
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
    const res = await this.post(msg, this.sessionId, undefined);
    // Session expired (server restart) → thử lại một lần không session.
    if ((res.status === 404 || res.status === 400) && this.sessionId) {
      this.sessionId = null;
      const retry = await this.post(msg, null, undefined);
      return this.consume(retry);
    }
    return this.consume(res);
  }

  close(): void {
    this.closed = true;
    this.sessionId = null;
  }

  private defaultTimeout(): number {
    return this.cfg.timeoutMs ?? 120_000;
  }

  private async post(msg: object, sessionId: string | null, signal?: AbortSignal): Promise<Response> {
    const url = this.cfg.url;
    if (!url) throw new Error("MCP HTTP transport requires \"url\" in the server config");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...expandEnv(this.cfg.headers),
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    try {
      // Combine the caller's abort signal (MCP A cancellation) with an idle
      // timeout into one AbortSignal. AbortSignal.any needs ≥1 real signal.
      const signals: AbortSignal[] = [AbortSignal.timeout(this.defaultTimeout())];
      if (signal) signals.push(signal);
      const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      return await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
        signal: combined,
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
    if (ct.includes("application/json")) {
      const body = (await res.text()).trim();
      if (body) {
        try { this.msgCb?.(JSON.parse(body) as Record<string, unknown>); } catch { /* skip malformed */ }
      }
      return;
    }
    if (ct.includes("text/event-stream")) {
      // MCP A: incremental SSE — stream body, emit each JSON-RPC message as
      // its `data:` event completes, instead of buffering the entire response.
      await this.consumeSseStream(res.body);
      return;
    }
    // 202/no-content (notifications) — nothing to parse
  }

  /** Incremental SSE: read the body as a stream and emit each JSON-RPC message
   *  as its SSE block (blank-line-separated) completes — no full-body buffer. */
  private async consumeSseStream(body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const msg = parseSseEvent(block);
          if (msg) this.msgCb?.(msg);
        }
      }
    } finally {
      reader.releaseLock();
    }
    // Flush any trailing partial SSE block at EOF (no trailing \n\n).
    if (buf.trim()) {
      const msg = parseSseEvent(buf);
      if (msg) this.msgCb?.(msg);
    }
  }
}

/** Parse a single SSE block (blank-line-separated events) into one JSON-RPC message.
 *  Normalizes CRLF → LF before splitting on the event separator. */
export function parseSseEvent(block: string): Record<string, unknown> | null {
  const data = block
    .replace(/\r\n/g, "\n")
    .split(/\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("\n");
  if (!data) return null;
  try { return JSON.parse(data) as Record<string, unknown>; } catch { return null; }
}

/** Parse SSE text (legacy buffer-based) thành JSON-RPC messages. */
export function parseSseMessages(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const m = parseSseEvent(block);
    if (m) out.push(m);
  }
  return out;
}

// ── JSON-RPC connection ──────────────────────────────────────────────────────

/** M1: connection state — surface qua onState cho AgentEvent mcp_status. */
export type McpConnState = "connecting" | "ready" | "reconnecting" | "dead" | "disabled";

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
  /** MCP A: inbound server notifications (tools/list_changed, progress…). */
  onNotification: ((msg: Record<string, unknown>) => void) | null = null;
  /** Server-reported metadata from `initialize` (surfaced on /mcp). */
  serverInfo: { name?: string; version?: string } = {};
  capabilities: Record<string, unknown> = {};
  instructions: string | null = null;
  /** Protocol version negotiated with the server. */
  protocolVersion = "2024-11-05";
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
    // MCP handshake: initialize + notifications/initialized. Negotiate the
    // highest protocol version we support that the server accepts.
    const initRes = await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: getVersion() },
    }, timeoutMs) as {
      protocolVersion?: string;
      capabilities?: Record<string, unknown>;
      serverInfo?: { name?: string; version?: string };
      instructions?: string;
    };
    this.protocolVersion = initRes.protocolVersion ?? "2024-11-05";
    this.capabilities = initRes.capabilities ?? {};
    this.serverInfo = initRes.serverInfo ?? {};
    this.instructions = initRes.instructions ?? null;
    void this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {
      // notification — không có pending để reject; lỗi sẽ lộ ở call sau.
    });
    this.setState("ready", "connected");
  }

  /** Wire inbound messages + channel-death → reconnect (stdio only). */
  private wireTransport(): void {
    this.transport.onMessage((msg) => {
      if (msg.id === undefined) {
        // Server notifications (tools/list_changed, progress, message) —
        // route them to the manager so it can react (re-register tools etc.).
        this.onNotification?.(msg);
        return;
      }
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

  /** MCP A: liveness probe — prefer ping (official MCP spec), fallback tools/list. */
  async healthy(timeoutMs = 5_000): Promise<boolean> {
    if (!this.alive) return false;
    try {
      // ping was added in MCP 2025-03; fall back to tools/list for older servers.
      if (this.capabilities.ping === true) {
        await this.rpc("ping", {}, timeoutMs);
      } else {
        await this.rpc("tools/list", {}, timeoutMs);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** MCP A: explicit ping. */
  async ping(timeoutMs = 5_000): Promise<void> {
    await this.rpc("ping", {}, timeoutMs);
  }

  async listTools(timeoutMs = 120_000): Promise<McpTool[]> {
    const res = await this.rpc("tools/list", {}, timeoutMs) as { tools?: McpTool[] };
    return (res.tools ?? []).filter((t): t is McpTool => typeof t.name === "string");
  }

  // ── Phase 4: resources ────────────────────────────────────────────────────

  async listResources(timeoutMs = 30_000): Promise<McpResource[]> {
    const res = await this.rpc("resources/list", {}, timeoutMs) as { resources?: McpResource[] };
    return (res.resources ?? []).filter((r): r is McpResource => typeof r.uri === "string");
  }

  async listResourceTemplates(timeoutMs = 30_000): Promise<McpResourceTemplate[]> {
    const res = await this.rpc("resources/templates/list", {}, timeoutMs) as { resourceTemplates?: McpResourceTemplate[] };
    return (res.resourceTemplates ?? []).filter((r): r is McpResourceTemplate => typeof r.uriTemplate === "string");
  }

  async readResource(uri: string, timeoutMs = 30_000): Promise<{ contents: McpResourceContents[] }> {
    const res = await this.rpc("resources/read", { uri }, timeoutMs) as { contents?: McpResourceContents[] };
    return { contents: res.contents ?? [] };
  }

  async subscribeResource(uri: string, timeoutMs = 30_000): Promise<void> {
    await this.rpc("resources/subscribe", { uri }, timeoutMs);
  }

  async unsubscribeResource(uri: string, timeoutMs = 30_000): Promise<void> {
    await this.rpc("resources/unsubscribe", { uri }, timeoutMs);
  }

  // ── Phase 4: prompts ──────────────────────────────────────────────────────

  async listPrompts(timeoutMs = 30_000): Promise<McpPrompt[]> {
    const res = await this.rpc("prompts/list", {}, timeoutMs) as { prompts?: McpPrompt[] };
    return (res.prompts ?? []).filter((p): p is McpPrompt => typeof p.name === "string");
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    timeoutMs = 30_000,
  ): Promise<{ description?: string; messages: McpPromptMessage[] }> {
    const res = await this.rpc("prompts/get", { name, arguments: args ?? {} }, timeoutMs) as {
      description?: string;
      messages?: McpPromptMessage[];
    };
    return { description: res.description, messages: res.messages ?? [] };
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
  /** Phase 4: server-pushed resource updates (after resources/subscribe). */
  onResourceUpdated: ((server: string, uri: string) => void) | null = null;
  /** Phase 4: progress notifications from long-running MCP tool calls. */
  onProgress: ((server: string, params: Record<string, unknown>) => void) | null = null;
  /** Phase 4: per-server resource/template cache (refreshed on list_changed). */
  private resources = new Map<string, { resources: McpResource[]; templates: McpResourceTemplate[] }>();
  /** Phase 4: per-server prompt cache. */
  private prompts = new Map<string, McpPrompt[]>();
  /** Phase 4: URIs subscribed per server. */
  private subscriptions = new Map<string, Set<string>>();

  constructor(private configs: Record<string, McpServerConfig>) {}

  /** Connect all servers; skip failures with a warning. Returns discovered tool count. */
  async connectAll(): Promise<number> {
    const report = this.onStatus ?? ((line: string) => console.error(line));
    await Promise.allSettled(
      Object.entries(this.configs).map(async ([name, cfg]) => {
        // MCP B: `enabled:false` and `trust:"readonly"` servers are NOT spawned —
        // readonly mode must never start an external process. Report them as
        // skipped so /mcp can still list them.
        if (cfg.enabled === false || cfg.trust === "readonly") {
          if (cfg.enabled === false) report(`· MCP "${name}" skipped (enabled: false)`);
          else report(`· MCP "${name}" skipped (trust: readonly — not spawned)`);
          this.onServerState?.(name, "disabled", cfg.enabled === false ? "enabled:false" : "trust:readonly");
          return;
        }
        const conn = new McpConnection(name, cfg);
        this.wireReconnect(name, conn);
        await conn.connect();
        await this.registerTools(name, conn);
        await this.refreshResources(name, conn);
        await this.refreshPrompts(name, conn);
        this.conns.set(name, conn);
      }),
    ).then((results) => {
      results.forEach((r, i) => {
        const name = Object.keys(this.configs)[i];
        const cfg = this.configs[name];
        if (cfg?.enabled === false || cfg?.trust === "readonly") return; // already reported as skipped
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

  /** M1: surface connection state machine + refresh tools sau reconnect + wire notifications. */
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
        // Refresh tool + resource + prompt lists — the server may have changed.
        conn
          .listTools()
          .then((defs) => this.reregisterTools(name, conn, defs))
          .catch(() => {});
        void this.refreshResources(name, conn);
        void this.refreshPrompts(name, conn);
      }
    };
    // MCP A: react to server notifications — tools/list_changed re-registers
    // the tool set (no full reconnect needed); progress/message are surfaced
    // as status lines but don't disrupt anything.
    conn.onNotification = (msg) => {
      const method = String(msg.method ?? "");
      const report = this.onStatus ?? ((line: string) => console.error(line));
      const params = (msg.params ?? {}) as Record<string, unknown>;
      if (method === "notifications/tools/list_changed" || method === "tools/list_changed") {
        conn
          .listTools()
          .then((defs) => {
            this.reregisterTools(name, conn, defs);
            report(`↻ MCP "${name}" tools changed — re-registered ${defs.length}`);
          })
          .catch(() => {});
      } else if (method === "notifications/resources/list_changed" || method === "resources/list_changed") {
        void this.refreshResources(name, conn).then(() => {
          const n = this.resources.get(name)?.resources.length ?? 0;
          report(`↻ MCP "${name}" resources changed — ${n} resource${n === 1 ? "" : "s"}`);
        });
      } else if (method === "notifications/prompts/list_changed" || method === "prompts/list_changed") {
        void this.refreshPrompts(name, conn).then(() => {
          const n = this.prompts.get(name)?.length ?? 0;
          report(`↻ MCP "${name}" prompts changed — ${n} prompt${n === 1 ? "" : "s"}`);
        });
      } else if (method === "notifications/resources/updated" || method === "resources/updated") {
        const uri = typeof params.uri === "string" ? params.uri : "";
        if (uri) {
          this.onResourceUpdated?.(name, uri);
          report(`↻ MCP "${name}" resource updated: ${uri}`);
        }
      } else if (method === "notifications/progress" || method === "progress") {
        // Long-running tool progress — forwarded to the UI hook (no chat spam).
        this.onProgress?.(name, params);
      } else if (method === "notifications/message" || method === "message") {
        report(`ℹ MCP "${name}": ${String(params.message ?? "message")}`);
      }
    };
  }

  private async registerTools(name: string, conn: McpConnection): Promise<void> {
    const defs = await conn.listTools();
    this.reregisterTools(name, conn, defs);
  }

  /** Phase 4: cache resources + templates when the server advertises them. */
  private async refreshResources(name: string, conn: McpConnection): Promise<void> {
    if (conn.capabilities.resources == null) {
      this.resources.delete(name);
      return;
    }
    let resources: McpResource[] = [];
    let templates: McpResourceTemplate[] = [];
    try { resources = await conn.listResources(); } catch { /* optional method */ }
    try { templates = await conn.listResourceTemplates(); } catch { /* optional method */ }
    this.resources.set(name, { resources, templates });
  }

  /** Phase 4: cache prompts when the server advertises them. */
  private async refreshPrompts(name: string, conn: McpConnection): Promise<void> {
    if (conn.capabilities.prompts == null) {
      this.prompts.delete(name);
      return;
    }
    try { this.prompts.set(name, await conn.listPrompts()); } catch { /* optional method */ }
  }

  /** MCP A: apply per-server tool include/exclude filters to a tool list. */
  private filterToolDefs(name: string, defs: McpTool[]): McpTool[] {
    const filter = this.configs[name]?.tools;
    if (!filter) return defs;
    const include = filter.include?.filter(Boolean) ?? [];
    const exclude = new Set((filter.exclude ?? []).map((s) => s.toLowerCase()));
    const match = (pat: string, n: string): boolean => {
      if (!pat.includes("*")) return n === pat.toLowerCase();
      const rx = new RegExp("^" + pat.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
      return rx.test(n);
    };
    return defs.filter((t) => {
      const n = t.name.toLowerCase();
      if (include.length > 0 && !include.some((pat) => match(pat, n))) return false;
      if ([...exclude].some((e) => match(e, n))) return false;
      return true;
    });
  }

  /** Replace một server's tool registrations (reconnect refresh) — honor config filters. */
  private reregisterTools(name: string, conn: McpConnection, defs: McpTool[]): void {
    for (const [key, t] of [...this.tools]) {
      if (t.serverName === name) this.tools.delete(key);
    }
    for (const def of this.filterToolDefs(name, defs)) {
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

  /** MCP A: connection state + metadata for /mcp status display.
   *  connected is based on McpConnection.state, not tool count. */
  serverStates(): Array<{
    name: string;
    state: McpConnState;
    serverInfo: { name?: string; version?: string };
    capabilities: Record<string, unknown>;
    instructions: string | null;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
  }> {
    return [...this.conns.entries()].map(([name, conn]) => ({
      name,
      state: conn.state,
      serverInfo: conn.serverInfo,
      capabilities: conn.capabilities,
      instructions: conn.instructions,
      toolCount: [...this.tools.values()].filter((t) => t.serverName === name).length,
      resourceCount: this.resources.get(name)?.resources.length ?? 0,
      promptCount: this.prompts.get(name)?.length ?? 0,
    }));
  }

  /** Phase 4: cached resources + templates per server. */
  listResourcesByServer(): Array<{ server: string; resources: McpResource[]; templates: McpResourceTemplate[] }> {
    return [...this.resources.entries()].map(([server, r]) => ({ server, ...r }));
  }

  /** Phase 4: cached prompts per server. */
  listPromptsByServer(): Array<{ server: string; prompts: McpPrompt[] }> {
    return [...this.prompts.entries()].map(([server, prompts]) => ({ server, prompts }));
  }

  hasResources(): boolean {
    return this.resources.size > 0;
  }

  hasPrompts(): boolean {
    return this.prompts.size > 0;
  }

  /** Phase 4: read a resource; optionally subscribe to its update notifications. */
  async readResource(
    server: string,
    uri: string,
    opts: { subscribe?: boolean } = {},
  ): Promise<{ ok: boolean; output: string }> {
    const conn = this.conns.get(server);
    if (!conn) return { ok: false, output: `ERROR: MCP server "${server}" is not connected.` };
    try {
      const res = await conn.readResource(uri);
      if (opts.subscribe) {
        try {
          await conn.subscribeResource(uri);
          const set = this.subscriptions.get(server) ?? new Set<string>();
          set.add(uri);
          this.subscriptions.set(server, set);
        } catch {
          // Subscription is best-effort; the read itself already succeeded.
        }
      }
      const parts = res.contents.map((c) => {
        if (typeof c.text === "string") return c.text;
        if (typeof c.blob === "string") {
          return `[binary ${c.mimeType ?? "application/octet-stream"} — ${c.blob.length} base64 chars]`;
        }
        return "";
      }).filter(Boolean);
      return { ok: true, output: redactSecrets(parts.join("\n")) || "(empty resource)" };
    } catch (err) {
      return { ok: false, output: `ERROR: resources/read failed: ${(err as Error).message}` };
    }
  }

  /** Phase 4: render a server prompt template into text messages. */
  async getPrompt(
    server: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<{ ok: boolean; output: string }> {
    const conn = this.conns.get(server);
    if (!conn) return { ok: false, output: `ERROR: MCP server "${server}" is not connected.` };
    try {
      const res = await conn.getPrompt(name, args);
      const msgs = res.messages.map((m) => {
        const content = m.content as { type?: string; text?: string } | undefined;
        const text = content && content.type === "text" && typeof content.text === "string"
          ? content.text
          : JSON.stringify(m.content);
        return `[${m.role ?? "user"}] ${text}`;
      });
      const header = res.description ? `${res.description}\n\n` : "";
      return { ok: true, output: redactSecrets(header + (msgs.join("\n\n") || "(empty prompt)")) };
    } catch (err) {
      return { ok: false, output: `ERROR: prompts/get failed: ${(err as Error).message}` };
    }
  }

  /** Phase 4: true when `name` is a generic resource/prompt tool. */
  isResourceTool(name: string): boolean {
    return MCP_RESOURCE_TOOL_NAMES.has(name);
  }

  /** Phase 4: specs for resource/prompt tools — advertised only when available. */
  resourceToolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    if (this.hasResources()) {
      specs.push({
        type: "function",
        function: {
          name: "mcp_list_resources",
          description:
            "List MCP resources and resource templates exposed by connected servers. " +
            "Use before mcp_read_resource when you don't know the URI.",
          parameters: schemaObj({ server: strProp("Optional server name — omit to list all servers") }, []),
        },
      });
      specs.push({
        type: "function",
        function: {
          name: "mcp_read_resource",
          description:
            "Read one MCP resource by URI (resources/read). Pass subscribe=true to receive " +
            "resources/updated notifications for that URI.",
          parameters: schemaObj(
            {
              server: strProp("Server name that owns the resource"),
              uri: strProp("Resource URI (from mcp_list_resources or a resource template)"),
              subscribe: boolProp("Subscribe to updates for this URI (default: false)"),
            },
            ["server", "uri"],
          ),
        },
      });
    }
    if (this.hasPrompts()) {
      specs.push({
        type: "function",
        function: {
          name: "mcp_list_prompts",
          description: "List prompt templates exposed by connected MCP servers.",
          parameters: schemaObj({ server: strProp("Optional server name — omit to list all servers") }, []),
        },
      });
      specs.push({
        type: "function",
        function: {
          name: "mcp_get_prompt",
          description: "Render one MCP prompt template (prompts/get) into text messages.",
          parameters: schemaObj(
            {
              server: strProp("Server name that owns the prompt"),
              name: strProp("Prompt name (from mcp_list_prompts)"),
              arguments: {
                type: "object",
                description: "Prompt arguments (string values)",
                additionalProperties: { type: "string" },
              },
            },
            ["server", "name"],
          ),
        },
      });
    }
    return specs;
  }

  /** Phase 4: dispatch a generic resource/prompt tool call. */
  async invokeResourceTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
    switch (name) {
      case "mcp_list_resources": {
        const server = typeof args.server === "string" ? args.server : undefined;
        const rows = this.listResourcesByServer().filter((r) => !server || r.server === server);
        if (rows.length === 0) return { ok: true, output: "(no MCP resources)" };
        return {
          ok: true,
          output: rows.map(({ server: s, resources, templates }) => {
            const lines = [`## ${s}`];
            for (const r of resources) {
              lines.push(`- ${r.uri}${r.name ? ` — ${r.name}` : ""}${r.mimeType ? ` (${r.mimeType})` : ""}`);
            }
            for (const t of templates) {
              lines.push(`- template: ${t.uriTemplate}${t.name ? ` — ${t.name}` : ""}`);
            }
            return lines.join("\n");
          }).join("\n\n"),
        };
      }
      case "mcp_read_resource": {
        const server = typeof args.server === "string" ? args.server : "";
        const uri = typeof args.uri === "string" ? args.uri : "";
        if (!server || !uri) return { ok: false, output: "ERROR: mcp_read_resource requires server and uri." };
        return this.readResource(server, uri, { subscribe: args.subscribe === true });
      }
      case "mcp_list_prompts": {
        const server = typeof args.server === "string" ? args.server : undefined;
        const rows = this.listPromptsByServer().filter((r) => !server || r.server === server);
        if (rows.length === 0) return { ok: true, output: "(no MCP prompts)" };
        return {
          ok: true,
          output: rows.map(({ server: s, prompts }) => {
            const lines = [`## ${s}`];
            for (const p of prompts) {
              const params = (p.arguments ?? []).map((a) => `${a.name}${a.required ? "" : "?"}`).join(", ");
              lines.push(`- ${p.name}${params ? ` (${params})` : ""}${p.description ? ` — ${p.description}` : ""}`);
            }
            return lines.join("\n");
          }).join("\n\n"),
        };
      }
      case "mcp_get_prompt": {
        const server = typeof args.server === "string" ? args.server : "";
        const promptName = typeof args.name === "string" ? args.name : "";
        if (!server || !promptName) return { ok: false, output: "ERROR: mcp_get_prompt requires server and name." };
        const rawArgs = args.arguments;
        const promptArgs: Record<string, string> = {};
        if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
          for (const [k, v] of Object.entries(rawArgs as Record<string, unknown>)) {
            if (typeof v === "string") promptArgs[k] = v;
          }
        }
        return this.getPrompt(server, promptName, promptArgs);
      }
      default:
        return { ok: false, output: `ERROR: unknown MCP resource tool "${name}".` };
    }
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
    this.resources.clear();
    this.prompts.clear();
    this.subscriptions.clear();
  }

  /** M4: config hot-reload — connect server mới, kill server đã bị xóa/changed khỏi config. */
  async applyConfig(configs: Record<string, McpServerConfig>): Promise<void> {
    const report = this.onStatus ?? ((line: string) => console.error(line));
    // A server's transport-effective config changed → restart it (kill + reconnect).
    const configChanged = (prev: McpServerConfig, next: McpServerConfig): boolean => {
      const pick = (c: McpServerConfig) =>
        JSON.stringify([c.command, c.url, c.type, c.args, c.env ?? {}, c.headers ?? {}, c.timeoutMs ?? null, c.tools ?? {}]);
      return pick(prev) !== pick(next);
    };
    // Server bị xóa hoặc đổi config → kill + unregister.
    for (const [name, conn] of [...this.conns]) {
      if (!configs[name] || configChanged(this.configs[name], configs[name])) {
        conn.kill();
        this.conns.delete(name);
        for (const [key, t] of [...this.tools]) {
          if (t.serverName === name) this.tools.delete(key);
        }
        this.resources.delete(name);
        this.prompts.delete(name);
        this.subscriptions.delete(name);
        if (configs[name] && configChanged(this.configs[name], configs[name])) {
          report(`↻ MCP "${name}" config changed — restarting`);
        } else {
          report(`✘ MCP "${name}" removed (config changed)`);
        }
      }
    }
    this.configs = configs;
    // Server mới → connect (except enabled:false / trust:readonly — never spawn).
    for (const [name, cfg] of Object.entries(configs)) {
      if (this.conns.has(name)) continue;
      if (cfg.enabled === false || cfg.trust === "readonly") {
        this.onServerState?.(name, "disabled", cfg.enabled === false ? "enabled:false" : "trust:readonly");
        report(`· MCP "${name}" skipped (${cfg.enabled === false ? "enabled: false" : "trust: readonly — not spawned"})`);
        continue;
      }
      const conn = new McpConnection(name, cfg);
      this.wireReconnect(name, conn);
      try {
        await conn.connect();
        await this.registerTools(name, conn);
        await this.refreshResources(name, conn);
        await this.refreshPrompts(name, conn);
        this.conns.set(name, conn);
        const n = [...this.tools.values()].filter((t) => t.serverName === name).length;
        report(`✓ MCP "${name}" connected — ${n} tool${n === 1 ? "" : "s"} (hot-reload)`);
      } catch (e) {
        report(`⚠  MCP server "${name}" unavailable: ${String((e as Error).message).slice(0, 160)}`);
      }
    }
  }
}
