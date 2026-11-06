import type { McpServerConfig, McpTransport } from "./types.js";
import { expandEnv } from "./env.js";
import { parseSseEvent } from "./sse.js";

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
