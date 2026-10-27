# P0.3 — Streaming Output

## Mục tiêu

Người dùng nhìn thấy token LLM stream ra real-time, thay vì chờ 30s–2 phút rồi nhận toàn bộ response cùng lúc.

## Phân tích vấn đề

`llm.ts:chat()` hiện tại dùng `fetch` không stream → gửi request → chờ response hoàn chỉnh → trả về. Với task dài, agent "đứng yên" 1-2 phút → người dùng không biết tool đang chạy hay treo.

## Thiết kế

### 1. Thêm stream flag vào LlmClient

```ts
interface LlmClientOptions {
  // ... existing fields ...
  stream: boolean; // default: true (tốt cho UX), fallback false nếu provider không hỗ trợ
}
```

Config: env `CODER_STREAM=1` hoặc `.coderrc.json`: `"stream": true`.

### 2. SSE Streaming implementation

OpenAI-compatible streaming endpoint nhận response dạng:

```
data: {"choices":[{"delta":{"content":"hello"}}]}
data: {"choices":[{"delta":{"content":" world"}}]}
data: [DONE]
```

Implement trong `llm.ts` — tách `chat()` thành:

```ts
// Non-streaming (giữ nguyên logic hiện tại)
async chat(messages, tools): Promise<ChatResult>

// Streaming — trả về async iterator để agent/UI xử lý từng chunk
async *streamChat(messages, tools): AsyncGenerator<StreamChunk>
```

`StreamChunk`:
```ts
interface StreamChunk {
  content?: string;        // delta text
  toolCallDelta?: {        // tool_calls delta (accumulate bằng index)
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  usage?: ChatResult["usage"];
  done: boolean;
}
```

### 3. Xử lý tool_calls trong stream

Tool calls xuất hiện động trong stream: delta `tool_calls[0].function.name` rồi `tool_calls[0].function.arguments`. Cần:
- Map theo `index` trong delta
- Accumulate arguments string qua các chunk
- Khi có đủ `name` + đầy đủ `arguments` → emit complete ToolCall

### 4. UI streaming

Trong `ui.ts`, thêm:

```ts
export function llmStream(prefix: string, onChunk: (text: string) => void): LlmStreamRenderer
// Trả về hàm để caller gọi mỗi chunk, UI tự render (in-place update)
```

Hoặc đơn giản hơn: `agent.ts` gọi `ui.llmStreamStart(prefix)` → `ui.llmStreamChunk(text)` → `ui.llmStreamEnd()`.

### 5. Graceful fallback

Nếu server trả lỗi khi stream (provider không hỗ trợ 400 on stream flag), retry non-stream một lần:

```ts
try {
  return await this.streamChat(messages, tools);
} catch (e) {
  if (e instanceof LlmError && !this.opts.stream) throw e;
  // Fallback: chuyển sang non-stream
  this.opts.stream = false;
  return this.nonStreamChat(messages, tools);
}
```

Một số provider (Ollama cũ, local vLLM) có thể không hỗ trợ streaming đúng cách.

### 6. Tool result streaming (optional, phase sau)

Khi `run_command` đang chạy, hiển thị output real-time thay vì chờ full output. Cần `execFile` không đồng bộ với `spawn` + stdout streaming. **Phase P0.3 này không làm phần này** — chỉ làm sau nếu cần.

## File changes

| File | Thay đổi |
|---|---|
| `src/llm.ts` | Thêm `streamChat()`, streaming SSE parser, ToolCall accumulator |
| `src/agent.ts` | Gọi streamChat thay vì chat; xử lý StreamChunk iterator |
| `src/config.ts` | Thêm `stream: boolean` (default true) |
| `src/ui.ts` | Thêm `llmStreamStart()`, `llmStreamChunk()`, `llmStreamEnd()` |
| `src/index.ts` | Truyền stream flag vào config |

## Acceptance criteria

1. `coder "viết function tính fibonacci"` → text stream ra real-time (không đợi full response)
2. Tool calls vẫn nhận đầy đủ sau khi stream hoàn tất (không broken)
3. Streaming error → fallback non-stream → task vẫn chạy được
4. Token count vẫn hiển thị sau khi stream xong
5. E2E test pass (mock LLM server cũng cần hỗ trợ streaming — cập nhật `test/mock-llm.mjs`)

## Mock LLM streaming

Cập nhật `test/mock-llm.mjs` để hỗ trợ stream: khi request có `"stream": true`, trả về SSE format. Dùng `ReadableStream` trong Bun/Fetch API.
