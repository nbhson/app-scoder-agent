import { type ChildProcess } from "node:child_process";
import { CLIENT_NAME, getVersion } from "../shared/version.js";
import { redactSecrets } from "../llm/llm.js";
import type { McpConnState, McpPrompt, McpPromptMessage, McpResource, McpResourceContents, McpResourceTemplate, McpServerConfig, McpTool, McpTransport } from "./types.js";
import { HttpTransport } from "./transport-http.js";
import { StdioTransport } from "./transport-stdio.js";

// ── JSON-RPC connection ──────────────────────────────────────────────────────

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
    const structured = res.structuredContent
      ? JSON.parse(redactSecrets(JSON.stringify(res.structuredContent))) as Record<string, unknown>
      : undefined;
    return { ok: !isErr, output: redactSecrets(parts.join("\n")) || "(empty result)", structured };
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
