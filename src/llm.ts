/**
 * Minimal OpenAI-compatible chat-completions client with function calling
 * and optional SSE streaming.
 */
import { withRetry } from "./retry.js";

// ---------------------------------------------------------------------------
// Secrets redaction (H-13) — shared by LLM error bodies, MCP tool output,
// compaction summaries and snapshot logs. Never log raw credentials.
// ---------------------------------------------------------------------------

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[^\s,&\]]+/gi, "Bearer ***REDACTED***"],
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-***REDACTED***"],
  [/sk-ant-[^\s,&\]]+/gi, "sk-ant-***REDACTED***"],
  [/ghp_[A-Za-z0-9]{20,}/g, "ghp_***REDACTED***"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***REDACTED***"],
  [/xox[bap]-[A-Za-z0-9-]{10,}/g, "xox***REDACTED***"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA***REDACTED***"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "***PRIVATE-KEY***"],
  [/\b(?:api[_-]?key|token|secret|password)["'\s:=]+[^\s"'&]{8,}/gi, "$1=***REDACTED***"],
];

/** Redact known secret shapes from arbitrary tool/LLM/log output. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [rx, replacement] of REDACTION_PATTERNS) {
    out = out.replace(rx, replacement);
  }
  return out;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  stop_reason?: string;
  tool_calls?: ToolCall[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Prompt tokens served from the provider cache (billed cheaper). */
  cached_tokens?: number;
  /** Extra usage fields from the provider (e.g. reasoning_tokens). */
  [key: string]: unknown;
}

export interface ChatResult {
  message: AssistantMessage;
  usage?: TokenUsage;
}

export interface LlmClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** Stream LLM output in real-time. Default: true. */
  stream?: boolean;
}

/** A piece of streamed output. */
export interface StreamChunk {
  /** Text delta from the assistant */
  contentDelta?: string;
  /** Tool call delta — accumulates per call until name+complete args received */
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  /** True when this is the last chunk */
  done: boolean;
  /** Only set on the final chunk */
  final?: ChatResult;
  /** Error (non-recoverable) */
  error?: string;
}

export class LlmError extends Error {
  status?: number;
  retryAfterMs?: number;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "LlmError";
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** Build an LlmError from a failed Response, carrying status + Retry-After. */
async function toLlmError(res: Response, url: string): Promise<LlmError> {
  let body = await res.text().catch(() => "");
  // Redact Bearer token and raw key patterns to avoid leaking secrets in logs/errors
  body = redactSecrets(body);
  const err = new LlmError(
    `LLM API error ${res.status} at ${url}: ${body.slice(0, 500)}`,
    res.status,
  );
  // Only honor a REAL Retry-After value: Number("") === 0 would zero the backoff
  const retryAfterHeader = res.headers.get("retry-after");
  if (retryAfterHeader != null && retryAfterHeader !== "") {
    const sec = Number(retryAfterHeader);
    if (Number.isFinite(sec) && sec > 0) err.retryAfterMs = sec * 1000;
  }
  return err;
}

// ---------------------------------------------------------------------------
// Request timeout / abort helpers
// ---------------------------------------------------------------------------

/** Default per-request timeout for LLM calls (a hung connection must not block the agent forever). */
export const LLM_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Combine an external signal with a request timeout.
 * Returns a derived signal plus a cleanup fn (removes listeners).
 * Works on Node >= 18 (no AbortSignal.any dependency).
 */
export function combinedSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; stopTimer: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException("LLM request timed out", "TimeoutError")), timeoutMs);
  const onExternal = () => ac.abort(new DOMException("aborted", "AbortError"));
  if (external) {
    if (external.aborted) ac.abort(external.reason);
    else external.addEventListener("abort", onExternal, { once: true });
  }
  return {
    signal: ac.signal,
    /** Clear only the request timer — keep the SIGINT listener alive. */
    stopTimer: () => clearTimeout(timer),
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternal);
    },
  };
}

// ---------------------------------------------------------------------------
// SSE parsing helpers
// ---------------------------------------------------------------------------

const SSE_PREFIX = "data: ";
const SSE_DONE = "[DONE]";

/** Parse SSE chunks from an OpenAI-compatible stream. */
function parseSSELine(line: string): string | null {
  if (!line.startsWith(SSE_PREFIX)) return null;
  const data = line.slice(SSE_PREFIX.length);
  if (data === SSE_DONE) return null; // [DONE] signals end
  return data;
}

// ---------------------------------------------------------------------------
// LlmClient
// ---------------------------------------------------------------------------

/**
 * Serialize conversation history to the OpenAI wire format. Internal ToolCall
 * shape is `{id, name, arguments}`; the API expects
 * `{id, type: "function", function: {name, arguments}}`. Some providers
 * (Upstage/solar) reject assistant tool_calls in the internal shape with a
 * misleading "Invalid function name: ''" error — always normalize here.
 */
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls) {
      return {
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return m;
  });
}

export class LlmClient {
  private streamEnabled: boolean;
  /** Last interrupted stream's accumulated tool calls (H-09 continuation). */
  lastPartialToolCalls: ToolCall[] = [];

  constructor(private opts: LlmClientOptions) {
    this.streamEnabled = opts.stream !== false; // default true
  }

  get model(): string {
    return this.opts.model;
  }

  // ── Non-streaming ──────────────────────────────────────────────────────────

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<ChatResult> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const { signal, cleanup } = combinedSignal(opts.signal, LLM_REQUEST_TIMEOUT_MS);
    const body = JSON.stringify({
      model: this.opts.model,
      messages: toWireMessages(messages),
      tools: tools.length > 0 ? tools : undefined,
      temperature: this.opts.temperature,
      max_tokens: this.opts.maxTokens,
      stream: false,
    });

    let res: Response;
    try {
      res = await withRetry(
        async () => {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
            body,
            signal,
          });
          if (!r.ok) throw await toLlmError(r, url);
          return r;
        },
        {},
        (attempt, delay, reason) =>
          console.error(`⚠  LLM request failed (${reason}), retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/3)...`),
      );
    } catch (err) {
      cleanup(); // timer must not survive a failed request
      throw err;
    }

    let data;
    try {
      // Keep the timeout alive through the body read — a hung body must also
      // surface as a timeout, not an eternal await.
      const pending = res.json();
      pending.catch(() => {}); // no-op catch for the abort path; awaited below
      data = (await pending) as {
        choices?: Array<{
          message?: {
            role?: string;
            content?: string | null;
            stop_reason?: string;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: TokenUsage;
      };
    } finally {
      cleanup();
    }

    const choice = data.choices?.[0]?.message;
    if (!choice) throw new LlmError("LLM API returned no message in response");

    // Extract cached prompt tokens when the provider reports them
    // (OpenAI-style: usage.prompt_tokens_details.cached_tokens).
    let usage: TokenUsage | undefined;
    if (data.usage) {
      usage = { ...data.usage };
      const details = (usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details;
      if (usage.cached_tokens === undefined && typeof details?.cached_tokens === "number") {
        usage.cached_tokens = details.cached_tokens;
      }
    }

    return {
      message: {
        role: "assistant",
        content: choice.content ?? null,
        stop_reason: choice.stop_reason ?? (choice.content ? "stop" : undefined),
        tool_calls: choice.tool_calls?.map((tc) => ({
          id: tc.id ?? "",
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        })),
      },
      usage,
    };
  }

  // ── Streaming ───────────────────────────────────────────────────────────────

  /**
   * Stream chat completions, yielding incremental chunks.
   * Falls back to non-streaming on stream-related errors.
   */
  async *streamChat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal; idleTimeoutMs?: number } = {},
  ): AsyncGenerator<StreamChunk> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const { signal, cleanup, stopTimer } = combinedSignal(opts.signal, LLM_REQUEST_TIMEOUT_MS);
    const bodyStr = JSON.stringify({
      model: this.opts.model,
      messages: toWireMessages(messages),
      tools: tools.length > 0 ? tools : undefined,
      temperature: this.opts.temperature,
      max_tokens: this.opts.maxTokens,
      stream: true,
      // OpenAI-compatible providers only include usage in streaming responses
      // when this flag is set — without it token accounting silently zeros out.
      stream_options: { include_usage: true },
    });

    let res: Response;
    try {
      res = await withRetry(
        async () => {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
            body: bodyStr,
            signal,
          });
          if (!r.ok) throw await toLlmError(r, url);
          return r;
        },
        {},
        (attempt, delay, reason) =>
          console.error(`⚠  LLM stream request failed (${reason}), retrying in ${(delay / 1000).toFixed(1)}s...`),
      );
    } catch (err) {
      cleanup(); // don't leak the 120s request timer — it would hang the process
      throw new LlmError(`Stream fetch error after retries at ${url}: ${(err as Error).message}`);
    }

    if (!res.body) {
      throw new LlmError("Response body is not readable (not a streaming response)");
    }

    // Headers received — the WHOLE-request timeout has served its purpose.
    // A long stream is normal (big models can stream for minutes), so from
    // here on we enforce an IDLE timeout instead: reset on every received
    // chunk; only a truly silent connection for idleTimeoutMs kills the read.
    // (The old whole-request timer fired mid-stream on long generations —
    // "LLM stream timed out while reading the response".) SIGINT still aborts
    // through the same signal — stopTimer keeps the external listener alive.
    stopTimer();
    const idleTimeoutMs = opts.idleTimeoutMs ?? LLM_REQUEST_TIMEOUT_MS;
    const readWithIdleTimeout = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      const ac = new AbortController();
      const t = setTimeout(
        () => ac.abort(new DOMException(`stream idle for ${idleTimeoutMs / 1000}s`, "TimeoutError")),
        idleTimeoutMs,
      );
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(ac.signal.reason), { once: true })),
        ]) as { done: boolean; value?: Uint8Array };
      } finally {
        clearTimeout(t);
      }
    };

    // Accumulators for tool_calls across chunks
    const accumulatedToolCalls: Array<{
      id?: string;
      name?: string;
      arguments: string;
    }> = [];

    let finalResult: ChatResult | undefined;
    let finalUsage: TokenUsage | undefined;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Reset the partial-call record for this stream (H-09 continuation).
    this.lastPartialToolCalls = [];

    try {
      while (true) {
        // Guard the pending read against a late abort (e.g. the idle timeout
        // firing while the consumer paused at a yield): attaching a no-op
        // catch prevents an unhandled rejection from crashing the process.
        const pending = readWithIdleTimeout();
        pending.catch(() => {});
        const { done, value } = await pending;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete line in buffer

        for (const rawLine of lines) {
          const json = parseSSELine(rawLine);
          if (!json) continue;

          let chunkData: {
            choices?: Array<{
              delta?: {
                role?: string;
                content?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: {
                    name?: string;
                    arguments?: string;
                  };
                }>;
              };
              finish_reason?: string;
            }>;
            usage?: TokenUsage;
          };
          try {
            chunkData = JSON.parse(json);
          } catch {
            continue; // skip malformed JSON lines
          }

          // Usage-only final chunk: many providers send usage in a chunk with
          // an empty choices array — must not be skipped.
          if (chunkData.usage) finalUsage = { ...chunkData.usage };

          const choice = chunkData.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Text content delta
          if (delta?.content != null && delta.content.length > 0) {
            yield { contentDelta: delta.content, done: false };
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!accumulatedToolCalls[idx]) {
                accumulatedToolCalls[idx] = { arguments: "" };
              }
              if (tc.id) accumulatedToolCalls[idx].id = tc.id;
              if (tc.function?.name) accumulatedToolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) {
                accumulatedToolCalls[idx].arguments += tc.function.arguments;
              }
              yield {
                toolCallDelta: {
                  index: idx,
                  id: tc.id,
                  name: tc.function?.name,
                  argumentsDelta: tc.function?.arguments,
                },
                done: false,
              };
            }
          }

          // Final chunk
          if (choice.finish_reason) {
            // Collect final tool_calls
            const toolCalls: ToolCall[] = accumulatedToolCalls
              .filter((tc) => tc.name)
              .map((tc) => ({
                id: tc.id ?? "",
                name: tc.name ?? "",
                arguments: tc.arguments,
              }));

            finalResult = {
              message: {
                role: "assistant",
                content: null,
                stop_reason: choice.finish_reason,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
              },
              usage: chunkData.usage,
            };
          }
        }
      }
    } catch (err) {
      // Normalize the abort timeout into LlmError so callers handle it as a
      // normal provider failure instead of a stray DOMException.
      const e = err as Error;
      if (e?.name === "TimeoutError" || /TimeoutError/.test(e?.message ?? "")) {
        throw new LlmError(`LLM stream timed out (${(e?.message ?? "").includes("idle") ? `no data for ${e.message.replace(/^.*idle for /, "")}` : "while reading the response"})`);
      }
      throw err;
    } finally {
      // H-09: record complete tool calls accumulated so far, for continuation.
      this.lastPartialToolCalls = accumulatedToolCalls
        .filter((tc) => tc.name)
        .map((tc) => ({ id: tc.id ?? "", name: tc.name as string, arguments: tc.arguments }));
      // Cancel the body (frees the socket) and clear the request timeout.
      // cancel() returns a promise — a rejection after abort must be swallowed
      // or it becomes an unhandled rejection that kills the process.
      try {
        const c = reader.cancel();
        if (c && typeof (c as Promise<void>).catch === "function") c.catch(() => {});
      } catch { /* already released */ }
      try { reader.releaseLock(); } catch { /* lock already released */ }
      cleanup();
    }

    // Attach usage collected from a usage-only chunk (choices: []) if the
    // finish chunk itself didn't carry it.
    if (finalResult && !finalResult.usage && finalUsage) finalResult.usage = finalUsage;
    yield { done: true, final: finalResult };
  }
}
