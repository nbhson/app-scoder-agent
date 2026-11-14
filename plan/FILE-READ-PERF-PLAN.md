# File-Read Perf Plan — vì sao "đọc file lâu", và sửa cả 3 nguyên nhân

> Trạng thái: **ĐÃ THỰC HIỆN** (P1–P4). Kết quả: `test/warmup.test.mjs` 9/9
> (thêm 3 case: adaptive budget, heartbeat re-warm bằng history thật, guard
> cloud/serve), `limits.test.mjs` cập nhật theo profile mới + 4 case
> `adaptiveToolOutputChars`, `perf-p0-p1` bắt footer format mới; toàn suite
> **976/976**, e2e + MCP smoke pass, build/typecheck/lint (0 errors)/
> check:layers/docs:check sạch.

## Mục lục

1. [Kết luận điều tra (số đo thật)](#1-kết-luận-điều-trà)
2. [Ba nguyên nhân](#2-ba-nguyên-nhân)
3. [Thiết kế fix](#3-thiết-kế-fix)
4. [Kế hoạch theo phase](#4-kế-hoạch-theo-phase)
5. [Chiến lược kiểm thử](#5-chiến-lược-kiểm-thử)
6. [Acceptance criteria](#6-acceptance-criteria)
7. [Edge cases](#7-edge-cases)
8. [Rủi ro & phương án dự phòng](#8-rủi-ro--phương-án-dự-phòng)

---

## 1. Kết luận điều tra (đo từ log thật)

**(a) Bản thân tool đọc file KHÔNG chậm.** `type:"tool"` trong `.scoder/logs`:

```
read_file: elapsedMs = 1ms   (grep = 22ms, run_command = 30ms)
```

**(b) Mỗi MẢNH file = một lượt LLM trọn vẹn.** Session `20261114-003806`
(task "phân tích readme.md", README.md 28KB) — khoảng cách giữa các message
assistant:

```
+8.2s  read_file (đoạn 1)      → tool cắt ở 6000 ký tự, hint "offset=125"
+9.5s  read_file offset=125
+9.3s  read_file offset=239
+9.2s  read_file offset=342
+11.3s read_file offset=407
+77.3s read_file offset=509 → câu trả lời
```

Một file tốn **6 bước ≈ 57s** chỉ để "nhìn xong", mỗi bước là một round-trip
LLM với history 11–14.5k token gửi lại.

**(c) Lượt đầu sau lúc engine nghỉ = cold prefill 35–56 giây:**

```
call 56600ms  ttft=54331ms  in=14488 cached=0      ← Ollama/llama.cpp hết keep_alive
call  1769ms  ttft=528ms    in=14569 cached=14505  ← cùng session, cache nóng (99%)
call  2173ms  ttft=689ms    in=11323 cached=11295  ← server 2-slot, cache 99%
```

Cache hit 98–99% thì mỗi bước đọc chỉ 0.6–2.2s; khi model bị unload, trả lại
toàn bộ cold-load + prefill.

## 2. Ba nguyên nhân

| # | Tầng | Cơ chế | Độ lớn |
|---|---|---|---|
| N1 | Ngân sách đọc | `limits.toolOutputChars` = 6000 chars (pin trong `LOCAL_PROFILE_DEFAULTS`, `config.ts:263`) → file vừa phải cũng thành 5–6 mảnh, mỗi mảnh một bước | ~9–11s × mảnh |
| N2 | Chiến lược của model | Model phát **một** `read_file` mỗi lượt dù executor đã hỗ trợ chạy song song 4 tool đọc (`run-loop.ts:251-254`, `toolConcurrency`) | ×6 lượt thay vì 1–2 |
| N3 | Engine lạnh | Ollama `keep_alive` mặc định ~5 phút; user ngừng gõ → model unload → lượt kế trả 35–56s. Warm-up hiện tại chỉ chạy MỘT LÚC mở session | 35–56s mỗi lần nguội |

Không sửa gì tầng fs — 1ms, không phải vấn đề.

## 3. Thiết kế fix

### Fix 1 (N1) — ngân sách đọc co theo context window THẬT

`toolOutputChars` không còn bị pin cứng 6000 khi local; suy ra từ window đã
probe, theo cùng triết lý `effectiveMcpSchemaCap` (P0-3):

```
adaptiveToolOutputChars(window) = clamp(round(window × 0.17), 6_000, 16_000)
```

(0.17 ký tự/token window ≈ 4% window ở thang token — một lần đọc không được
chiếm quá phần nhỏ history; 4 chars ≈ 1 token.)

- window 16k (slot nhỏ) → 6000 (nguyên trạng — không phình history khi window hẹp)
- window 96k → 16000 → README 28KB còn 2 mảnh
- user đặt tường minh `limits.toolOutputChars` → luôn thắng
- chỉ áp dụng khi `isLocalBaseUrl` (cloud: giữ mặc định 8000, không đổi hành vi)

Điểm áp: cuối `applyContextProbe()` (window vừa probe/đã đặt) → ghi vào
`config.limits.toolOutputChars` + `setMaxToolOutputChars()` để cả `read-file.ts`
lẫn safety-net trong `tool-executor.ts:200` cùng nhận giá trị mới. Log
`{"type":"read_budget"}` để đo lại được.

### Fix 2 (N2) — dạy model đọc hết các mảnh trong MỘT bước

Prompt V6 (`PROMPT_SECTIONS.tools`) thêm 1 dòng luật đọc phân mảnh: thấy
footer "`N more line(s)`" → phát NGAY các `read_file(offset=…)` cho TOÀN BỘ
phần còn lại trong cùng một lượt — executor song song hoá (read-only, an toàn).
6 bước → 2 bước với file 28KB (bước 1 đọc thử, bước 2 gọi nốt 2–3 offset song song).

Không bump PROMPT_VERSION (V6 chưa phát hành rộng; đổi nội dung ghi CHANGELOG,
`prompt_version` log giữ nguyên ý nghĩa so sánh giữa major).

### Fix 3 (N3) — idle re-warm: timmer heartbeat cho engine cục bộ
Warm-up hiện tại (plan/WARMUP-PLAN.md) một-shot. Thêm lịch: khi session
interactive NHÀN RỖI ≥ `WARMUP_IDLE_REFRESH_MS = 240_000` (dưới TTL cache
~5 phút của Anthropic/Ollama), tự gửi lại request prefill:

- thân request = **history thật hiện tại** (`this.messages`) nếu đã có (chính
  xác hơn placeholder — prefix của lượt kế tiếp là history cũ + message mới,
  re-warm bằng history thật thì toàn bộ prefix nóng), hoặc prefix `[warmup]`
  như cũ khi session còn trống.
- `max_tokens: 1`, vứt response — với Ollama còn là ping `keep_alive`: model
  không bao giờ unload khi scoder đang mở.
- CHỈ khi `isLocalBaseUrl` — API trả phí: không đốt tiền để giữ cache (mọi
  lượt thật tự refresh TTL).
- Timer `.unref()` (không giữ process sống), cancel khi: run thật bắt đầu
  (`settleWarmup`), `dispose()`, `abort()`. Re-arm sau `finish()` và sau mỗi
  cycle re-warm → heartbeat đều đặn khi idle, im lặng khi chạy.
- Skip theo đúng các guard cũ: `warmup: false`, `clientFactory`, thiếu apiKey.
- Test knob: `agent.warmupIdleRefreshMs` (đặt ngắn trong test).
- **Bổ sung khi test (P3)**: `scheduleWarmupRefresh` KHÔNG được return sớm khi
  điều kiện đổi — `/model` local→cloud giữa session phải TẮT timer đang arm
  (clearWarmupTimer ở mọi guard fail), nếu không heartbeat sẽ đốt API trả phí.
  Test guard bắt đúng bug này trước khi fix.

## 4. Kế hoạch theo phase

- **P1 — Budget** (`config.ts`, `agent.ts`): `adaptiveToolOutputChars()`;
  bỏ pin `toolOutputChars` khỏi `LOCAL_PROFILE_DEFAULTS`/`applyLocalProfile`;
  `applyAdaptiveReadBudget()` gọi ở mọi đường ra của `applyContextProbe`.
- **P2 — Prompt** (`context/prompt.ts`): dòng luật đọc phân mảnh trong
  `PROMPT_SECTIONS.tools` (V6).
- **P3 — Idle re-warm** (`agent.ts`): `warmup({rewarm})`, `scheduleWarmupRefresh`,
  heartbeat trong `runWarmup` (dùng history thật), clear ở `settleWarmup` /
  `dispose` / `abort`, re-arm ở `finish()`.
- **P4 — Test + docs**: cập nhật `limits.test.mjs` (profile không pin
  toolOutputChars nữa) + thêm case `adaptiveToolOutputChars`; mở rộng
  `warmup.test.mjs` (idle refresh, re-warm bằng history, non-local không
  heartbeat); `docs/configuration.md`, `docs/performance.md`, CHANGELOG.

## 5. Chiến lược kiểm thử

1. Unit `adaptiveToolOutputChars`: 16128→6000, 64000→10880, 96000→16000,
   200000→16000 (chặn trần), 4096→6000 (sàn).
2. Agent với stub server + `contextWindow: 96000`, local baseUrl, không khai
   báo limits → request run đầu tiên có `max_tokens` bình thường và một
   `read_file` 10KB trả về KHÔNG kèm footer "more line(s)" (một mảnh trọn vẹn);
   với `contextWindow: 16128` → vẫn cắt 6000.
3. `limits.test.mjs`: applyLocalProfile không còn đụng `toolOutputChars`
   (`applied` còn 3 mục); user đặt 3000 vẫn thắng.
4. Warmup refresh: knob `warmupIdleRefreshMs = 200`; sau `warmup()` settle,
   chờ 600ms → stub nhận request `max_tokens=1` thứ hai; sau `run()` thì
   request re-warm chứa message user "…" (history thật), không chứa "[warmup]".
5. Non-local (`https://…` không có server) → `warmupTimer` null, không heartbeat.
6. Regression: toàn suite + e2e + MCP smoke; `check:layers`, `docs:check`.

## 6. Acceptance criteria

- `npm run build && npm run typecheck && npm run lint` sạch; suite full + e2e pass.
- Log JSONL có `{"type":"read_budget", chars, window}` cho session local.
- Session local window lớn: file 28KB đọc ≤ 2 bước (trước: 6).
- REPL/TUI mở, idle >4': đúng một request `max_tokens:1` mỗi chu kỳ, có
  `{"type":"warmup"}` log thứ hai trở đi; `Ctrl+C`/`dispose` chặn ngay, process
  thoát sạch (timer unref).
- `warmup: false` hoặc `localProfile: false` hoặc cloud → không heartbeat.
- User đặt `limits.toolOutputChars` → adaptive không ghi đè.

## 7. Edge cases

- **Window nhỏ (16k slot)**: adaptive = 6000, y hệt hiện tại — không phình
  history ở máy yếu (đúng chủ đích P0-2/P2-3).
- **Rewarm khi history rất dài** (gần trần compaction): request warm = cả
  history, engine có thể tự cắt — chấp nhận (lượt thật cũng vậy); warm-up fail
  im lặng, không ảnh hưởng run.
- **`/clear` giữa idle**: agent cũ dispose (clear timer), REPL gọi warmup()
  agent mới → lịch mới tự sinh.
- **Timer fires đúng lúc user submit**: `settleWarmup` abort request warm →
  run không chậm hơn; phần prefill đã tính vẫn nằm trong cache engine.
- **run-once/serve**: không warm-up → không bao giờ schedule heartbeat.
- **Rewarm đổi prefix giữa chu kỳ** (file sửa lúc idle): build từ history +
  system prompt hiện hành → request kế của run thật khớp đúng prefix mới.
- **Ollama vs llama.cpp**: ping giữ model loaded (Ollama); llama.cpp giữ slot
  KV slot-active — cả hai đều được hưởng lợi, không cần cờ engine phía user
  (vẫn ghi docs khuyến nghị `OLLAMA_KEEP_ALIVE=-1` cho ai muốn tuyệt đối).

## 8. Rủi ro & phương án dự phòng

| Rủi ro | Mức | Dự phòng |
|---|---|---|
| History phình nhanh hơn (16k chars/lượt thay 6k) → compaction/trim đến sớm trên window giữa | TB | công thức clamp theo window: chỉ nới khi window ≥ ~35k token; sàn 6000 |
| Heartbeat đốt GPU máy cá nhân khi để treo qua đêm | TB | chỉ local + interval 4' + một request 1-token; tắt bằng `warmup:false` |
| Model nhỏ không tuân luật đọc song song, vẫn đọc tuần tự | TB | không sai, chỉ chậm như cũ; footer hint của tool vẫn giữ |
| `applied` list của profile đổi (bớt `toolOutputChars`) làm test/docs cũ lệch | Cao | cập nhật `limits.test.mjs` + docs/performance.md cùng phase |
| Timer giữ process alive trong test/e2e | Cao | `.unref()` + clear trong dispose; e2e chạy `agent.dispose()` |
