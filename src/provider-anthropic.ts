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
import type { ChatMessage, ChatResult, StreamChunk, ToolSpec } from "./llm.js";
import { LlmError } from "./llm.js";
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

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
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
        let input: Record<string, unknown> = {};
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

  return {
    message: {
      role: "assistant",
      content: text.length > 0 ? text : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    usage: {
      prompt_tokens: data.usage?.input_tokens,
      completion_tokens: data.usage?.output_tokens,
    },
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

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/messages`;
    const { system, messages: translated } = toAnthropicMessages(messages);
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

    const res = await withRetry(
      async () => {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.opts.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body,
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

    const data = (await res.json()) as AnthropicResponse;
    if (data.error) {
      throw new LlmError(`Anthropic API error: ${data.error.message ?? "unknown"}`);
    }
    return fromAnthropicResponse(data);
  }

  /**
   * Streaming: Anthropic SSE has a different event model (content_block_delta).
   * For now, delegate to non-streaming chat and emit one final chunk.
   * Full Anthropic streaming is planned for P2.
   */
  async *streamChat(messages: ChatMessage[], tools: ToolSpec[]): AsyncGenerator<StreamChunk> {
    const result = await this.chat(messages, tools);
    yield { done: true, final: result };
  }
}

async function toAnthropicError(res: globalThis.Response, url: string): Promise<LlmError> {
  let body = await res.text().catch(() => "");
  body = body.replace(/sk-ant-[^\s,&\]]+/gi, "sk-ant-***REDACTED***");
  const retryAfterSec = Number(res.headers.get("retry-after") ?? "");
  const err = new LlmError(
    `Anthropic API error ${res.status} at ${url}: ${body.slice(0, 500)}`,
    res.status,
  );
  if (Number.isFinite(retryAfterSec)) err.retryAfterMs = Number(retryAfterSec) * 1000;
  return err;
}
