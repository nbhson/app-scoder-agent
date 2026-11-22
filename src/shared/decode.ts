/**
 * Multi-byte-safe decoding of streamed bytes (P1-15).
 *
 * Node hands out socket/stdout chunks at arbitrary byte offsets. A UTF-8
 * character that straddles a chunk boundary decodes to U+FFFD when a chunk is
 * converted on its own with `chunk.toString("utf8")` — so a Vietnamese task
 * string, an emoji in tool output, or a JSON-RPC frame from an MCP server
 * gets silently corrupted (and a corrupted frame breaks every later message on
 * that line). `StringDecoder` keeps the trailing partial bytes until the next
 * chunk arrives; this module wraps it in the three shapes the codebase needs.
 *
 * The correct pattern already existed in `tools/webfetch.ts` and the SSE
 * providers (`new TextDecoder("utf-8", {stream: true})`); every child_process
 * and socket site now goes through here instead of re-decoding per chunk.
 */
import { StringDecoder } from "node:string_decoder";

/** Decode chunks as one continuous UTF-8 stream. */
export class Utf8Stream {
  private decoder = new StringDecoder("utf8");

  /** Text for this chunk; incomplete trailing bytes are carried over. */
  write(chunk: Buffer | string): string {
    return this.decoder.write(chunk);
  }

  /** Flush the carry-over at end of stream (a lone partial byte → U+FFFD). */
  end(): string {
    return this.decoder.end();
  }
}

/**
 * Accumulate streamed text, optionally capped in CHARACTERS (the caps in this
 * repo are output-budget caps, not byte budgets).
 */
export class Utf8Buffer extends Utf8Stream {
  private parts: string[] = [];
  private size = 0;

  /**
   * `limit` in characters, or a getter when the budget is runtime-tunable
   * (`MAX_OUTPUT_CHARS` is module-global and another Agent may re-set it
   * mid-run — resolving it per chunk keeps the old behaviour).
   */
  constructor(private readonly limit: number | (() => number) = Number.POSITIVE_INFINITY) {
    super();
  }

  private cap(): number {
    return typeof this.limit === "function" ? this.limit() : this.limit;
  }

  /**
   * The FULLY decoded delta (uncapped — callers stream it to the UI/TUI), while
   * `text` keeps only the first `limit` characters for the final payload.
   */
  push(chunk: Buffer | string): string {
    const delta = super.write(chunk);
    if (delta) {
      const room = this.cap() - this.size;
      if (room > 0) this.parts.push(delta.length > room ? delta.slice(0, room) : delta);
      this.size += delta.length;
    }
    return delta;
  }

  get text(): string {
    return this.parts.join("");
  }

  /** Characters seen so far (can exceed `limit` — use it to stop early). */
  get length(): number {
    return this.size;
  }

  /** Flush partial bytes and return the capped text. */
  finish(): string {
    const tail = super.end();
    if (tail) this.push(tail);
    return this.text;
  }
}

/**
 * Newline-delimited framing over a byte stream (MCP JSON-RPC stdio, and any
 * `readline`-less protocol reader): incomplete lines AND incomplete multi-byte
 * characters wait for the next chunk instead of being parsed corrupted.
 */
export class Utf8LineFramer {
  private decoder = new StringDecoder("utf8");
  private buf = "";
  /** Soft cap on the pending buffer; frames beyond it are dropped at a newline. */
  private static readonly MAX_PENDING = 8 * 1024 * 1024;

  /** Complete lines (newline stripped), oldest first. */
  feed(chunk: Buffer | string): string[] {
    this.buf += this.decoder.write(chunk);
    const out: string[] = [];
    // P-perf: scan with an offset — `buf = buf.slice()` per line re-copied the
    // whole remainder (N lines × M bytes = quadratic in a burst).
    let start = 0;
    let i: number;
    while ((i = this.buf.indexOf("\n", start)) !== -1) {
      out.push(this.buf.slice(start, i));
      start = i + 1;
    }
    if (start > 0) this.buf = this.buf.slice(start);
    // A stream that never terminates a frame (garbage / wrong protocol) must
    // not grow without bound — drop the pending run past the cap.
    if (this.buf.length > Utf8LineFramer.MAX_PENDING) this.buf = "";
    return out;
  }

  /** Un-terminated remainder (flushed partial byte included). */
  rest(): string {
    return this.buf + this.decoder.end();
  }
}
