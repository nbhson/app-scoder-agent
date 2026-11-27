/**
 * Anthropic Messages API provider.
 *
 * Translates between the agent's OpenAI-style ChatMessage/ToolSpec format and
 * the Anthropic /v1/messages API:
 *  - system message  -> `system` field
 *  - tool_calls      -> content blocks {type:"tool_use"}
 *  - role:"tool"     -> {role:"user", content:[{type:"tool_result"}]}
 *  - response blocks -> assistant message + tool_calls
 */
import type { ChatMessage, ChatResult, TokenUsage, ToolCall, StreamChunk, ToolSpec } from "./llm.js";
import { LlmError, LLM_REQUEST_TIMEOUT_MS, combinedSignal, redactSecrets } from "./llm.js";
import { formatRetryDelay, withRetry } from "./retry.js";
import { parseToolArgsCached } from "./tool-args.js";

// ---------------------------------------------------------------------------
// Anthropic wire types
// ---------------------------------------------------------------------------

type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; cache_control?: { type: "ephemeral" } };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  /** "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" — F3: không có nó thì
   *  một đáp án bị cắt vì hết token output trông y hệt đáp án hoàn chỉnh. */
  stop_reason?: string;
  error?: { message?: string };
}

// ---------------------------------------------------------------------------
// Translation: OpenAI-style -> Anthropic
// ---------------------------------------------------------------------------

// P-perf: `toAnthropicMessages` chạy TOÀN bộ history mỗi request — mỗi lần
// lại JSON.parse mọi tool_call arguments (write_file chứa cả file vài trăm KB).
// History append-only (P0-1) ⇒ memo WeakMap theo object tool_call là hợp lệ;
// validate bằng reference chuỗi arguments. `block.input` chỉ đi qua
// JSON.stringify phía serialize (và phía parse ở fromAnthropicResponse),
// không ai mutate ⇒ chia sẻ object an toàn.
function parseToolArgs(tc: { arguments?: string }): Record<string, unknown> {
  // P-perf: delegate to the shared memoized parser (same WeakMap semantics);
  // Anthropic serialization SWALLOWS malformed args (the wire payload is
  // `input: {}`) instead of throwing like the agent-side callers.
  try {
    return parseToolArgsCached(tc as { arguments: string });
  } catch {
    return {};
  }
}

export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }

    if (m.role === "tool") {
      // Tool results become user tool_result blocks; consecutive tool results
      // are merged into one user message (Anthropic requirement).
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: m.content ?? "",
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        const input = parseToolArgs(tc);
        blocks.push({ type: "tool_use", id: tc.id || `call_${tc.name}`, name: tc.name, input });
      }
      out.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : (m.content ?? ""),
      });
      continue;
    }

    // user
    out.push({ role: "user", content: m.content ?? "" });
  }

  return { system: systemParts.join("\n\n") || undefined, messages: out };
}

// ---------------------------------------------------------------------------
// Translation: Anthropic -> OpenAI-style ChatResult
// ---------------------------------------------------------------------------

export function fromAnthropicResponse(data: AnthropicResponse): ChatResult {
  let text = "";
  let thinking = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for (const block of data.content ?? []) {
    if (block.type === "text") {
      text = text ? `${text}\n${block.text ?? ""}` : (block.text ?? "");
    } else if (block.type === "thinking") {
      thinking += (block as { thinking?: string }).thinking ?? "";
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }

  const usage: TokenUsage = {
    prompt_tokens: data.usage?.input_tokens,
    completion_tokens: data.usage?.output_tokens,
  };
  if (typeof data.usage?.cache_read_input_tokens === "number") {
    usage.cached_tokens = data.usage.cache_read_input_tokens;
  }
  return {
    message: {
      role: "assistant",
      content: text.length > 0 ? text : null,
      // F3: "max_tokens" = bị cắt vì hết token output. Stream path đã lấy
      // stop_reason từ message_delta; bản non-stream này từng bỏ hẳn field.
      stop_reason: data.stop_reason,
      reasoning: thinking || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    usage,
  };
}

// ---------------------------------------------------------------------------
// AnthropicClient — same surface as LlmClient
// ---------------------------------------------------------------------------

const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicClient {
  /** Last interrupted stream's accumulated tool calls (H-09 continuation). */
  lastPartialToolCalls: ToolCall[] = [];

  constructor(
    private opts: {
      baseUrl: string;
      apiKey: string;
      model: string;
      maxTokens: number;
      temperature: number;
      /** I-04: cache_control ephemeral on system + tools + last user turn. */
      enableCache?: boolean;
      /** I-05: thinking budget tokens (Anthropic extended thinking). 0 = off. */
      thinkingBudgetTokens?: number;
      /** G7: per-request timeout ms (default LLM_REQUEST_TIMEOUT_MS). */
      requestTimeoutMs?: number;
      /** P2.1: extra headers from the provider def (auth headers below always win). */
      headers?: Record<string, string>;
    },
  ) {}

  /** P2.1: custom headers merged first; x-api-key / version / content-type win. */
  private requestHeaders(): Record<string, string> {
    return {
      ...(this.opts.headers ?? {}),
      "Content-Type": "application/json",
      "x-api-key": this.opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  private get timeoutMs(): number {
    return this.opts.requestTimeoutMs ?? LLM_REQUEST_TIMEOUT_MS;
  }

  /**
   * I-04 prompt caching — Anthropic 4-block formula (≤4 cache breakpoints):
   * tools (last block), system, and the last user message get
   * `cache_control: {type: "ephemeral"}`. Applied only when enableCache.
   */
  private applyCacheControl(
    system: string | undefined,
    translated: AnthropicMessage[],
    tools: ToolSpec[] | undefined,
  ): { system: unknown; messages: AnthropicMessage[]; tools: unknown } {
    if (!this.opts.enableCache) return { system, messages: translated, tools };
    const CC = { cache_control: { type: "ephemeral" } } as const;
    // System: string → single block array with marker.
    const sysOut = system
      ? [{ type: "text", text: system, ...CC }]
      : undefined;
    // Tools: last definition carries the marker.
    const toolsOut = tools && tools.length > 0
      ? tools.map((t, i) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
          ...(i === tools.length - 1 ? CC : {}),
        }))
      : undefined;
    // Last user message: annotate final content block (string → block array).
    const messages = [...translated];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        const c = messages[i].content;
        if (typeof c === "string") {
          messages[i] = { ...messages[i], content: [{ type: "text", text: c, ...CC }] };
        } else if (c.length > 0) {
          messages[i] = { ...messages[i], content: [...c.slice(0, -1), { ...c[c.length - 1], ...CC }] };
        }
        break;
      }
    }
    return { system: sysOut, messages, tools: toolsOut };
  }

  get model(): string {
    return this.opts.model;
  }

  /** T-04: runtime hot-swap — next request uses the new model id. */
  setModel(model: string): void {
    this.opts = { ...this.opts, model };
  }

  /** I-05: request body builder — shared by chat/streamChat. */
  private buildBody(
    system: unknown,
    messages: AnthropicMessage[],
    tools: unknown,
    stream: boolean,
    maxTokensOverride?: number,
  ): string {
    // Extended thinking: temperature must be 1 và thinking block format.
    const thinkingOn = (this.opts.thinkingBudgetTokens ?? 0) > 0;
    return JSON.stringify({
      model: this.opts.model,
      max_tokens: maxTokensOverride ?? this.opts.maxTokens,
      temperature: thinkingOn ? 1 : this.opts.temperature,
      ...(thinkingOn ? { thinking: { type: "enabled", budget_tokens: this.opts.thinkingBudgetTokens } } : {}),
      system,
      messages,
      stream,
      tools,
    });
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal; maxTokens?: number } = {},
  ): Promise<ChatResult> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/messages`;
    const { system, messages: translated } = toAnthropicMessages(messages);
    const { signal, cleanup } = combinedSignal(opts.signal, this.timeoutMs);
    const cached = this.applyCacheControl(system, translated, tools);
    // WARMUP: override max_tokens cho request prefill — các breakpoint
    // cache_control (tools + system) đã áp dụng y hệt lượt thật.
    const body = this.buildBody(cached.system, cached.messages, cached.tools, false, opts.maxTokens);

    let res: Response;
    try {
      res = await withRetry(
        async () => {
          const r = await fetch(url, {
            method: "POST",
            headers: this.requestHeaders(),
            body,
            signal,
          });
          if (!r.ok) throw await toAnthropicError(r, url);
          return r;
        },
        // caller signal only — the 120s request timeout must not cut quota backoffs
        { signal: opts.signal },
        (attempt, delay, reason) =>
          console.error(
            `⚠  Anthropic request failed (${reason}), retrying in ${formatRetryDelay(delay)} (retry ${attempt})...`,
          ),
      );
    } finally {
      cleanup();
    }

    const data = (await res.json()) as AnthropicResponse;
    if (data.error) {
      throw new LlmError(`Anthropic API error: ${data.error.message ?? "unknown"}`);
    }
    return fromAnthropicResponse(data);
  }

  /**
   * Streaming: parse Anthropic SSE events (message_start, content_block_delta,
   * message_delta, message_stop) and translate them to StreamChunks:
   *  - text_delta            -> contentDelta
   *  - tool_use + input_json_delta -> toolCallDelta accumulation
   *  - message_delta stop_reason/usage -> final ChatResult
   */
  async *streamChat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal; idleTimeoutMs?: number } = {},
  ): AsyncGenerator<StreamChunk> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/messages`;
    const { system, messages: translated } = toAnthropicMessages(messages);
    const { signal, cleanup, stopTimer } = combinedSignal(opts.signal, this.timeoutMs);
    const cached = this.applyCacheControl(system, translated, tools);
    const body = this.buildBody(cached.system, cached.messages, cached.tools, true);

    let res: Response;
    try {
      res = await withRetry(
        async () => {
          const r = await fetch(url, {
            method: "POST",
            headers: this.requestHeaders(),
            body,
            signal,
          });
          if (!r.ok) throw await toAnthropicError(r, url);
          return r;
        },
        { signal: opts.signal },
        (attempt, delay, reason) =>
          console.error(`⚠  Anthropic stream request failed (${reason}), retrying in ${formatRetryDelay(delay)} (retry ${attempt})...`),
      );
    } catch (err) {
      cleanup(); // don't leak the 120s request timer — it would hang the process
      throw new LlmError(`Anthropic stream fetch error after retries at ${url}: ${(err as Error).message}`);
    }

    if (!res.body) {
      throw new LlmError("Anthropic stream: response body is not readable");
    }

    // Accumulators — text content + tool_use blocks (by block index)
    let text = "";
    let thinkingAccum = "";
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: string | undefined;
    let usage: ChatResult["usage"] | undefined;
    let sawStop = false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Headers received — switch whole-request timeout to idle timeout per read
    // (same rationale as LlmClient.streamChat: long streams are normal).
    stopTimer();
    const idleTimeoutMs = opts.idleTimeoutMs ?? this.timeoutMs;
    // P-perf: ONE watchdog interval + activity timestamp instead of an
    // AbortController + setTimeout + Promise.race + listener PER CHUNK — a
    // 50 chunk/s stream used to allocate ~200 throwaway objects/second on the
    // hot path. Idle detection lags at most 1s (the floor timeout is ≥30s).
    const idleAc = new AbortController();
    let lastActivity = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity >= idleTimeoutMs) {
        idleAc.abort(new DOMException(`stream idle for ${idleTimeoutMs / 1000}s`, "TimeoutError"));
      }
    }, 1_000);
    watchdog.unref?.();
    const readWithIdleTimeout = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      if (idleAc.signal.aborted) throw idleAc.signal.reason;
      let onAbort: () => void = () => {};
      const abortP = new Promise<never>((_, rej) => {
        onAbort = () => rej(idleAc.signal.reason);
        idleAc.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([reader.read(), abortP]);
      } finally {
        // Shared signal: remove this read's listener, otherwise one per chunk
        // would accumulate for the whole stream (MaxListenersExceeded + leak).
        idleAc.signal.removeEventListener("abort", onAbort);
      }
    };

    const handleEvent = (raw: string): StreamChunk | null => {
      let ev: {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };
      try {
        ev = JSON.parse(raw) as typeof ev;
      } catch {
        return null;
      }

      if (ev.type === "message_start") {
        // Initial usage (input tokens) arrives on message_start
        if (ev.message?.usage) {
          usage = {
            prompt_tokens: ev.message.usage.input_tokens,
            completion_tokens: ev.message.usage.output_tokens,
          };
          if (typeof ev.message.usage.cache_read_input_tokens === "number") {
            usage.cached_tokens = ev.message.usage.cache_read_input_tokens;
          }
        }
        return null;
      }

      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        toolBlocks.set(ev.index ?? 0, {
          id: ev.content_block.id ?? "",
          name: ev.content_block.name ?? "",
          json: "",
        });
        return null;
      }

      if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          text += ev.delta.text;
          return { contentDelta: ev.delta.text, done: false };
        }
        // I-05: thinking deltas stream as their own content block type.
        if (ev.delta?.type === "thinking_delta" && (ev.delta as { thinking?: string }).thinking) {
          const t = (ev.delta as { thinking?: string }).thinking ?? "";
          thinkingAccum += t;
          return { reasoningDelta: t, done: false };
        }
        if (ev.delta?.type === "input_json_delta" && ev.delta.partial_json) {
          const block = toolBlocks.get(ev.index ?? 0);
          if (block) block.json += ev.delta.partial_json;
          return {
            toolCallDelta: { index: ev.index ?? 0, argumentsDelta: ev.delta.partial_json },
            done: false,
          };
        }
        return null;
      }

      if (ev.type === "message_delta") {
        stopReason = ev.delta?.stop_reason ?? stopReason;
        // Merge: message_delta usage only carries output_tokens
        if (ev.usage) {
          usage = {
            ...usage,
            prompt_tokens: usage?.prompt_tokens ?? ev.usage.input_tokens,
            completion_tokens: ev.usage.output_tokens ?? usage?.completion_tokens,
          };
          if (usage?.cached_tokens === undefined && typeof ev.usage.cache_read_input_tokens === "number") {
            usage = { ...usage, cached_tokens: ev.usage.cache_read_input_tokens };
          }
        }
        return null;
      }

      if (ev.type === "message_stop") {
        sawStop = true;
        return null;
      }

      return null;
    };

    let finalResult: ChatResult | undefined;

    // Reset the partial-call record for this stream (H-09 continuation).
    this.lastPartialToolCalls = [];

    try {
      while (true) {
        // Guard the pending read against a late abort (idle watchdog firing
        // while the consumer paused at a yield): a no-op catch prevents an
        // unhandled rejection from crashing the process.
        const pending = readWithIdleTimeout();
        pending.catch(() => {});
        const { done, value } = await pending;
        if (done) break;
        lastActivity = Date.now(); // watchdog: a chunk proves the connection is alive
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;

          const chunk = handleEvent(payload);
          if (chunk) yield chunk;
        }
      }

      if (sawStop) {
        const toolCalls: ToolCall[] = [...toolBlocks.values()]
          .filter((b) => b.name)
          .map((b) => ({ id: b.id, name: b.name, arguments: b.json || "{}" }));
        finalResult = {
          message: {
            role: "assistant",
            content: text.length > 0 ? text : null,
            reasoning: thinkingAccum || undefined,
            stop_reason: stopReason,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          usage,
        };
      }
    } finally {
      clearInterval(watchdog); // P-perf: shared idle watchdog off
      // H-09: record complete tool calls accumulated so far, for continuation.
      this.lastPartialToolCalls = [...toolBlocks.values()]
        .filter((b) => b.name)
        .map((b) => ({ id: b.id, name: b.name, arguments: b.json || "{}" }));
      try {
        const c = reader.cancel();
        if (c && typeof (c as Promise<void>).catch === "function") c.catch(() => {});
      } catch { /* already released */ }
      try { reader.releaseLock(); } catch { /* lock already released */ }
      cleanup();
    }

    yield { done: true, final: finalResult };
  }
}

async function toAnthropicError(res: globalThis.Response, url: string): Promise<LlmError> {
  let body = await res.text().catch(() => "");
  body = redactSecrets(body);
  const err = new LlmError(
    `Anthropic API error ${res.status} at ${url}: ${body.slice(0, 500)}`,
    res.status,
  );
  const retryAfterHeader = res.headers.get("retry-after");
  if (retryAfterHeader != null && retryAfterHeader !== "") {
    const sec = Number(retryAfterHeader);
    if (Number.isFinite(sec) && sec > 0) err.retryAfterMs = sec * 1000;
  }
  return err;
}
