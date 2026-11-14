# Warm-up Plan — Pre-fill prefix system+tools ngay khi mở session

> Trạng thái: **ĐÃ THỰC HIỆN** (P1–P6). Kết quả: `test/warmup.test.mjs` 6/6,
> toàn bộ unit suite 973/973, e2e + MCP smoke pass, build/typecheck/lint/
> check:layers/docs:check sạch. Quyết định đã chốt khi thực hiện:
> Q1 = mặc định BẬT cho REPL/TUI (tắt bằng rc `"warmup": false`), KHÔNG bật cho
> run-once/server (task đã chờ sẵn, warm-up chỉ nhân đôi prefill);
> Q2 = warm-up dùng `max_tokens: 1` qua `chat()` (không stream) — đã thêm
> override `maxTokens` vào surface `chat` (cả hai provider + contract);
> Q3 = skip warm-up khi `clientFactory` được set (harness eval dùng client
> scripted — warm-up sẽ ăn mất một lượt kịch bản).
> Q4 (mở) = `/clear` trong TUI vẫn tạo agent lazy lúc submit sau → chưa re-warm
> ngay; REPL đã re-warm qua `replaceAgent`. Ghi nhận, không đổi lần này vì
> wiring `onEvent` nằm trong `createAgent` của app.tsx.

## Mục lục

1. [Mục tiêu & phạm vi](#1-mục-tiêu--phạm-vi)
2. [Hiện trạng: vì sao lượt chat đầu "đóng băng"](#2-hiện-trạng)
3. [Thiết kế](#3-thiết-kế)
4. [Kế hoạch theo phase](#4-kế-hoạch-theo-phase)
5. [Chiến lược kiểm thử](#5-chiến-lược-kiểm-thử)
6. [Acceptance criteria](#6-acceptance-criteria)
7. [Edge cases](#7-edge-cases)
8. [Rủi ro & phương án dự phòng](#8-rủi-ro--phương-án-dự-phòng)

---

## 1. Mục tiêu & phạm vi

**Mục tiêu:** lượt chat ĐẦU TIÊN không còn phải trả toàn bộ chi phí khởi động
trên đường tới token đầu. Ngay khi mở REPL/TUI, agent gửi background một request
"làm nóng" chứa **đúng prefix system + tools** mà lượt thật sẽ gửi, với
`max_tokens: 1`. Kết quả:

- engine local (llama.cpp/Ollama/LM Studio/vLLM): prefix KV-cache được tính sẵn,
  model được nạp vào VRAM sẵn (tránh cả cold-load + prefill 20–60k token, tức
  30–120s, khỏi lượt đầu).
- Anthropic API: request warm-up là lệnh **cache write** cho breakpoint
  tools+system (I-04 đã đặt sẵn `cache_control`), lượt thật đọc cache
  (billed ~10% input).
- OpenAI/Gemini: automatic prefix caching hoạt động giống local engine.

**Trong phạm vi:**

- `src/agent.ts` — method `warmup()` + cancel/settle khi run thật tới.
- `src/agent/prompt-context.ts` — `peekPendingContext()` (đọc không tiêu thụ).
- `src/llm/llm.ts`, `src/llm/provider-anthropic.ts`, `src/llm/provider-registry.ts`
  — override `maxTokens` trong `chat(opts)`.
- `src/llm/retry.ts` — AbortError không được retry.
- `src/config/config.ts` — key rc `warmup` (boolean, mặc định bật).
- `src/cli/repl.ts`, `src/tui/app.tsx` — trigger warm-up lúc start.
- `test/warmup.test.mjs` + docs/CHANGELOG/.scoderrc.example.json.

**Ngoài phạm vi:**

- KHÔNG đổi composition của system prompt, không đổi event schema cho UI,
  không tự động refresh cache khi idle (mọi lượt thật đều tự refresh TTL).
- `run-once`/`server` không gọi warm-up (giữ nguyên hành vi).

## 2. Hiện trạng

Toàn bộ chi phí khởi động nằm trên đường tới token đầu của tin nhắn đầu:

| Việc | Vị trí | Chi phí |
|---|---|---|
| `buildRunMessages` (env, skills, agents guide, repo map — FS đồng bộ) | `agent.ts:1061` | ~ms–trăm ms |
| `applyContextProbe` | `agent.ts:1074`, cap 1.5s | tới 1.5s |
| `connectMcp` — spawn MCP server | `agent.ts:1075` | vài giây |
| LLM cold-load + prefill system+tools | bước 1 của `runLoop` | **20–60k token > 120s trên máy cá nhân** (`config.ts:252` comment P2-3) |

Prefix đã được chủ đích giữ stable byte (P0-10 dời repo map khỏi system prompt
thành user message cuối prefix) → warm-up với task placeholder là hợp lệ về
cache. Điểm phân duy nhất giữa warm và real: message user cuối (task thật),
và AGENTS.md nested guide nếu task mention file (chấp nhận — chỉ mất re-prefill
đuôi, xem [§7](#7-edge-cases)).

## 3. Thiết kế

```
repl / tui start ──► agent.warmup()  (fire-and-forget)
                        │
                        ├─ Promise.allSettled([applyContextProbe, connectMcp])
                        ├─ tool list + messages = đúng như run() dựng
                        │   (pendingContext peek, task "[warmup]")
                        └─ client.chat(messages, tools, { signal, maxTokens: 1 })
                                → vứt response, chỉ log {type:"warmup", ms, tokens}

user gõ lệnh đầu ──► run()/runTurn()/resume():
                        await settleWarmup()   // abort request warm + đợi promise
                                                 // (chặn connectMcp double-spawn)
                        → tiếp tục như cũ, prefix đã warm
```

Quyết định thiết kế đã chốt:

- **One-shot + không tiêu thụ state**: `warmup()` idempotent; dùng
  `peekPendingContext()` và `pendingTools()` (không `take`/`clearPendingTools`)
  — staged skill vẫn nguyên vẹn cho run thật.
- **Không污染 history/usage**: request warm đi thẳng `client.chat`, không qua
  `callModel` → không vào `this.messages`, không cộng `usageTotals`, không ghi
  event log cuộc hội thoại; chỉ ghi một dòng JSONL `{"type":"warmup"}`.
- **Priority cho lượt thật**: `settleWarmup()` abort request warm ngay khi run
  thật tới; phần probe/MCP connect (có ích sẵn) thì await cho settle.
- **Tôn trọng harness**: skip khi `config.clientFactory` set (I-12).
- **abort()/dispose()** hủy luôn warm-up (SIGINT không để request con mồ côi;
  dispose không để MCP server con mọc lại sau khi kill).

## 4. Kế hoạch theo phase

- **P1 — LLM surface**: `chat(opts.maxTokens)` trong `llm.ts`,
  `provider-anthropic.ts` (buildBody nhận override), `provider-registry.ts`
  (contract); `retry.ts`: `name === "AbortError"` → throw ngay, không retry.
- **P2 — Agent**: field `warmupRun` + `disposed`; method `warmup()`,
  `runWarmup()`, `settleWarmup()`; gọi `settleWarmup()` ở đầu `run()`,
  `runTurn()`, `resume()`; abort trong `abort()`/`dispose()`.
- **P3 — PromptContext**: `peekPendingContext()`.
- **P4 — Config**: `AgentConfig.warmup` + `RcFile.warmup` + `loadConfig`.
- **P5 — Trigger**: `repl.ts` (start + replaceAgent), `tui/app.tsx` (mount,
  bỏ qua khi có `initialTask`).
- **P6 — Test + docs**: `test/warmup.test.mjs`; `docs/configuration.md`
  (key `warmup`); `.scoderrc.example.json`; CHANGELOG.

## 5. Chiến lược kiểm thử

Test unit với stub HTTP server (pattern `perf-p0-p1.test.mjs` — createServer +
`new Agent(cfg)` trỏ `baseUrl` loopback, `contextWindow` đặt sẵn để skip probe):

1. `warmup()` gửi **đúng 1** request `chat/completions`, `max_tokens === 1`,
   `stream === false`, chứa system message; `agent.messages` vẫn rỗng.
2. System prompt của request warm **trùng khớp byte** system prompt của request
   run thật (cache-key alignment) — so trường `system`/messages[0] giữa 2 body.
3. `run()` sau `warmup()` settle: không có request warm thứ hai; run gửi đúng
   số bước kịch bản + 1 warm.
4. `"warmup": false` → `warmup()` là no-op, 0 request.
5. `clientFactory` set → `warmup()` no-op.

## 6. Acceptance criteria

- `npm run build && npm run typecheck && npm run lint` sạch.
- `node --test test/warmup.test.mjs` pass; các test liên quan không hồi quy:
  `llm`, `anthropic`, `anthropic-cache`, `config`, `agent-v2`, `event-v2`,
  `hot-reload`, `perf-p0-p1`, `compaction`.
- JSONL log có dòng `{"type":"warmup", ok:true, ms, promptTokens}` cho session
  REPL/TUI bật warm-up.
- Hành vi cũ giữ nguyên khi `warmup: false`.

## 7. Edge cases

- **Task đầu mention file** → AGENTS.md nested guide làm system prompt thật
  khác warm → Anthropic cache-read miss ở breakpoint system, **tools breakpoint
  vẫn hit**; local engine re-prefill từ điểm guide (đuôi). Không sai, chỉ bớt
  hiệu quả — chấp nhận, ghi rõ.
- **Idle quá TTL cache** (Anthropic 5 phút, Ollama `keep_alive` ~5 phút): lượt
  thật trả lại prefill như trước — warm-up không làm TỆ HƠN.
- **Repo/env đổi giữa warm và real** (user sửa file lúc idle): repo map là
  message đuôi → chỉ đuôi re-prefill; env snapshot trong system có thể đổi →
  miss system, vẫn hit tools.
- **MCP connect chậm**: `settleWarmup` await nó — tổng thời gian lượt đầu
  không hơn hiện tại (hiện tại connectMcp cũng nằm trong run()).
- **Provider từ chối `max_tokens: 1`**: warm-up fail im lặng (best-effort),
  lượt thật không bị ảnh hưởng.
- **Server mode/run-once**: không trigger → 0 request thừa, không tốn phí.

## 8. Rủi ro & phương án dự phòng

| Rủi ro | Mức | Dự phòng |
|---|---|---|
| Đốt API quota/thẻ người dùng dùng gói giới hạn requests | TB | rc `"warmup": false` tài liệu hóa rõ |
| Eval/scripted tests thấy request "lạ" | TB | skip khi `clientFactory`; test harness không gọi `warmup()` |
| connectMcp race warm↔run (double-spawn server con) | Cao | `settleWarmup()` await warm promise TRƯỚC khi run vào critical path |
| Request warm kẹt khi run() bắt đầu làm chậm lượt thật | TB | abort-first trong `settleWarmup`; prefill đã tính vẫn nằm trong engine cache |
| Zombie MCP server sau dispose | TB | flag `disposed` → abort warm + `shutdownMcp()` trong finally |
