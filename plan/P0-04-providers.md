# P0.4 — Provider Layer (Anthropic native + Retry)

## Mục tiêu

1. Hỗ trợ Anthropic native Messages API (không phải qua OpenAI compat)
2. Retry với exponential backoff cho lỗi tạm thời (429, 5xx, network)

## Phân tích vấn đề

### Anthropic native API khác OpenAI:

- Header: `x-api-key` (không phải `Authorization: Bearer`) + `anthropic-version: 2023-06-01`
- Endpoint: `/v1/messages` (không phải `/chat/completions`)
- Request body: `{ model, max_tokens, system, messages, tools }` — system là **trường riêng**, không nằm trong messages
- Response: `{ content: [{type:"text", text}, {type:"tool_use", id, name, input}], usage: {input_tokens, output_tokens} }`
- Tool result message: `{ role: "user", content: [{type:"tool_result", tool_use_id, content}] }`

### Retry

Hiện tại 1 request fail (429 rate limit, 500, network hiccup) → agent chết ngay. Cần retry tự động.

## Thiết kế

### 1. Provider abstraction

```ts
// src/providers/types.ts
export interface Provider {
  name: string;
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult>;
  streamChat?(messages: ChatMessage[], tools: ToolSpec[]): AsyncGenerator<StreamChunk>;
}
```

Factory `createProvider(config)`:
- `provider === "anthropic"` hoặc baseUrl chứa `api.anthropic.com` → `AnthropicProvider`
- Mặc định → `OpenAICompatProvider` (code hiện tại)

### 2. AnthropicProvider (`src/providers/anthropic.ts`)

Translation layer:

**Request:**
```
OpenAI format                    Anthropic format
─────────────────────────────    ─────────────────────────────
{model, messages:[               {model, max_tokens, system,
  {role:"system", ...},            messages: [
  {role:"user", ...},                {role:"user"/"assistant", content},
  {role:"assistant",tool_calls},     {role:"user", content:[
  {role:"tool",tool_call_id,...}       {type:"tool_result", tool_use_id, content}
]}                                   ]}
                                   ],
                                   tools: [{name, description, input_schema}]
                                 }
```

Chuyển đổi:
- `role:"system"` đầu tiên → trường `system` (string)
- `tool_calls` trong assistant message → `content: [{type:"tool_use", id, name, input}]` (input = JSON.parse(arguments))
- `role:"tool"` messages → gộp thành `role:"user"` với `content:[{type:"tool_result", ...}]`
- Tools spec: `parameters` → `input_schema`

**Response:**
```
Anthropic content: [
  {type:"text", text:"..."}          → message.content
  {type:"tool_use", id, name, input} → tool_calls: [{id, name, arguments: JSON.stringify(input)}]
]
usage: {input_tokens, output_tokens} → {prompt_tokens, completion_tokens}
```

Anthropic yêu cầu: sau mỗi `tool_use` phải có `tool_result` trong message user tiếp theo, và không được có 2 tool_use block liền nhau trong 1 message nếu thiếu tool_result. Agent hiện tại push `role:"tool"` messages tuần tự — provider phải nhóm chúng lại đúng chuẩn Anthropic.

Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`.

### 3. Retry với exponential backoff (`src/retry.ts`)

```ts
async function withRetry<T>(fn: () => Promise<T>, opts?: {
  maxRetries?: number;     // default 3
  baseDelayMs?: number;    // default 1000
  maxDelayMs?: number;     // default 30000
}): Promise<T>
```

- Retry khi: HTTP 429, 500, 502, 503, 504, network error (ECONNRESET, ETIMEDOUT)
- Không retry khi: 400, 401, 403, 404 (client error — retry vô ích)
- Delay: `baseDelay * 2^attempt + jitter(0-500ms)`
- Tôn trọng `Retry-After` header nếu có (429)
- Log ra stderr: `⚠  LLM request failed (429), retrying in 2.1s (attempt 1/3)...`

### 4. Provider auto-detect

Logic chọn provider (trong `config.ts`):
1. Nếu `.coderrc.json` có `"provider"` → dùng
2. Nếu baseUrl chứa `api.anthropic.com` → anthropic
3. Nếu model bắt đầu bằng `claude-` → anthropic
4. Mặc định → openai-compatible

Env: `CODER_PROVIDER=anthropic|openai`. CLI: `--provider anthropic`.

Default baseUrl khi `provider=anthropic` và không có baseUrl: `https://api.anthropic.com/v1`. Default model: `claude-sonnet-4-5`.

### 5. API key env var theo provider

- Anthropic: `ANTHROPIC_API_KEY` (thứ tự: `CODER_API_KEY` > provider-specific > generic `OPENAI_API_KEY`)

## File changes

| File | Thay đổi |
|---|---|
| `src/provider.ts` | **NEW** — interface Provider + factory |
| `src/provider-openai.ts` | Tách từ llm.ts hiện tại (non-stream + stream) |
| `src/provider-anthropic.ts` | **NEW** — Anthropic Messages API + message translation |
| `src/retry.ts` | **NEW** — withRetry + backoff |
| `src/config.ts` | Thêm `provider` field + auto-detect |
| `src/index.ts` | Flag `--provider` |
| `src/agent.ts` | Dùng `provider.chat()` thay vì `LlmClient.chat` |

## Acceptance criteria

1. `coder --provider anthropic -m claude-sonnet-4-20250514 "task"` hoạt động end-to-end (tool calls, build loop)
2. `coder -m gpt-4o-mini "task"` (mặc định openai) vẫn hoạt động như cũ
3. Lỗi 429 → tự retry với backoff, log ra stderr, không crash
4. Lỗi 401 → không retry, fail ngay với message rõ ràng
5. Message conversion đúng: system prompt, tool_calls, tool results không bị lỗi thứ tự
6. Typecheck + e2e pass
