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
import { LlmError, LLM_REQUEST_TIMEOUT_MS, combinedSignal } from "./llm.js";
import { withRetry } from "./retry.js";

// ---------------------------------------------------------------------------
// Anthropic wire types
// ---------------------------------------------------------------------------

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  error?: { message?: string };
}

// ---------------------------------------------------------------------------
// Translation: OpenAI-style -> Anthropic
// ---------------------------------------------------------------------------

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
        let input: Record<string, unknown>;
        try {
          input = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
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
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for (const block of data.content ?? []) {
    if (block.type === "text") {
      text = text ? `${text}\n${block.text ?? ""}` : (block.text ?? "");
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
  constructor(
    private opts: {
      baseUrl: string;
      apiKey: string;
      model: string;
      maxTokens: number;
      temperature: number;
    },
  ) {}

  get model(): string {
    return this.opts.model;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<ChatResult> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/messages`;
    const { system, messages: translated } = toAnthropicMessages(messages);
    const { signal, cleanup } = combinedSignal(opts.signal, LLM_REQUEST_TIMEOUT_MS);
    const body = JSON.stringify({
      model: this.opts.model,
      max_tokens: this.opts.maxTokens,
      temperature: this.opts.temperature,
      system,
      messages: translated,
      tools:
        tools.length > 0
          ? tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            }))
          : undefined,
    });

    let res: Response;
    try {
      res = await withRetry(
        async () => {
          const r = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": this.opts.apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
            },
            body,
            signal,
          });
          if (!r.ok) throw await toAnthropicError(r, url);
          return r;
        },
        {},
        (attempt, delay, reason) =>
          console.error(
            `⚠  Anthropic request failed (${reason}), retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/3)...`,
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
    opts: { signal?: AbortSignal } = {},
  ): AsyncGenerator<StreamChunk> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/messages`;
    const { system, messages: translated } = toAnthropicMessages(messages);
    const { signal, cleanup } = combinedSignal(opts.signal, LLM_REQUEST_TIMEOUT_MS);
    const body = JSON.stringify({
      model: this.opts.model,
      max_tokens: this.opts.maxTokens,
      temperature: this.opts.temperature,
      system,
      messages: translated,
      stream: true,
      tools:
        tools.length > 0
          ? tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            }))
          : undefined,
    });

    let res: Response;
    try {
      res = await withRetry(
        async () => {
          const r = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": this.opts.apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
            },
            body,
            signal,
          });
          if (!r.ok) throw await toAnthropicError(r, url);
          return r;
        },
        {},
        (attempt, delay, reason) =>
          console.error(`⚠  Anthropic stream request failed (${reason}), retrying in ${(delay / 1000).toFixed(1)}s...`),
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
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: string | undefined;
    let usage: ChatResult["usage"] | undefined;
    let sawStop = false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
            stop_reason: stopReason,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          usage,
        };
      }
    } finally {
      try { reader.cancel(); } catch { /* already released */ }
      reader.releaseLock();
      cleanup();
    }

    yield { done: true, final: finalResult };
  }
}

async function toAnthropicError(res: globalThis.Response, url: string): Promise<LlmError> {
  let body = await res.text().catch(() => "");
  body = body.replace(/sk-ant-[^\s,&\]]+/gi, "sk-ant-***REDACTED***");
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
