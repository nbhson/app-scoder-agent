import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { McpServerConfig, McpTransport } from "./types.js";
import { expandEnv } from "./env.js";
import { Utf8LineFramer, Utf8Stream } from "../shared/decode.js";

/** stdio transport — spawn process, line-delimited JSON-RPC trên stdin/stdout. */
export class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;
  proc: ChildProcess | null = null;
  /** Tail of the server's stderr (last 4KB) — surfaced on connect failures. */
  stderrTail = "";
  /**
   * P1-15: line framing + UTF-8 reassembly in one place. Decoding each stdout
   * chunk on its own corrupted any JSON-RPC frame whose bytes straddled a
   * chunk boundary (multi-byte characters in tool results) — the parse then
   * produced mojibake or dropped a frame the manager kept waiting for.
   */
  private framer = new Utf8LineFramer();
  /** stderr is diagnostics only — decoded as its own UTF-8 stream. */
  private stderrDecoder = new Utf8Stream();
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
    // Reconnect reuses this instance — a leftover half-frame from the dead
    // process would corrupt the first message of the new one.
    this.framer = new Utf8LineFramer();
    this.stderrDecoder = new Utf8Stream();
    p.stderr?.on("data", (c: Buffer) => {
      // Keep the tail for diagnostics (server logs/help output on crash);
      // otherwise stderr is intentionally ignored. P1-15: decode through the
      // stream decoder so a split multi-byte character cannot garble it.
      this.stderrTail = (this.stderrTail + this.stderrDecoder.write(c)).slice(-4096);
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
    for (const raw of this.framer.feed(chunk)) {
      const line = raw.trim();
      if (!line) continue;
      try { this.msgCb?.(JSON.parse(line) as Record<string, unknown>); } catch { /* skip malformed */ }
    }
  }
}
