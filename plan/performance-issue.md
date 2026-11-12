# Performance Issue — Agent chậm bất thường với local model (~6 giờ vs 3–5 phút)

> **Trạng thái:** Đã fix toàn bộ backlog §7 (P0-1…P2-4) — số liệu trước/sau ở §8.1
> **Ngày phân tích:** 12/11/2026
> **Phạm vi:** `app-scoder-agent` chạy local model qua Ollama / llama.cpp
> **Session mẫu:** `20261106-023204-670b` (model `qwen3.6:35b`)
> **Mức độ:** Critical — chênh lệch ~70–100× so với OpenCode trên cùng model

---

## 1. TL;DR

Không phải model chậm. Vấn đề là **agent đốt quá nhiều token đầu vào và liên tục phá KV-cache** của llama.cpp/Ollama.

- Một session thực tế: **40 lượt gọi LLM, 1.585.575 input token, chỉ 3.547 output token, `cachedTokens: 0`**.
- Chỉ một câu “chào” đã tốn **25.799 input token**, trong đó **~20.322 token là schema tool** (46 tool GitHub MCP + prompt-gate + built-in).
- Tốc độ sụp đúng lúc tool result thứ 21 xuất hiện: **11,9 giây/lượt → 141,3 giây/lượt**.
- Nguyên nhân: `trimHistory()` xoá tool result cũ **ngay giữa prefix prompt**, khiến KV-cache mất hiệu lực từ token đầu tiên bị sửa → local model phải prefill lại toàn bộ.
- 1.585.575 token ở ~73 token/s prefill ≈ **6 giờ**. Cùng khối lượng đó trên máy nhanh hơn (~350 token/s) vẫn mất ~75 phút.

OpenCode nhanh vì lịch sử **append-only giữa các lần compaction**, prompt mặc định nhỏ hơn, và nó dùng đúng context window thật của model.

---

## 2. Bằng chứng từ log thật

### 2.1 Số liệu session `20261106-023204-670b`

Nguồn: `.scoder/sessions/20261106-023204-670b.json` và `events.jsonl`.

| Chỉ số | Giá trị |
|---|---|
| Số lượt gọi LLM | 40 |
| Input token | 1.585.575 |
| Output token | 3.547 |
| Cached token | **0** |
| Tỉ lệ input/output | **~447:1** |

Đây là dấu hiệu kinh điển của “prompt re-prefill liên tục”, không phải model suy luận nhiều.

### 2.2 Điểm gãy latency

| Giai đoạn | Số lượt | Tổng thời gian | Trung bình |
|---|---|---|---|
| Trước khi prune | 27 | 5,3 phút | **11,9 s/lượt** |
| Sau khi prune | 23 | 54,1 phút | **141,3 s/lượt** |

- Lượt 27 mất ~10 s.
- Lượt 28 mất **138 s**.
- Đúng lúc tool result thứ 21 xuất hiện — ngưỡng `KEEP_RECENT_TOOL_RESULTS = 20`.

### 2.3 Vì sao thay đổi nhỏ lại gây hậu quả lớn

Tool result đầu tiên là một `read_file` dài 1.518 ký tự, nằm **ngay sau system prompt**. Khi bị thay bằng `[pruned — old tool result]`:

```
[system prompt][tool result #1 bị đổi][... toàn bộ phần còn lại]
                ^ token thay đổi ở đây
```

KV-cache của llama.cpp/Ollama chỉ dùng lại được **prefix không đổi**. Một token bị sửa ở giữa → **toàn bộ phần sau bị xoá cache** → prefill lại từ đầu. Càng về sau history càng dài, prefill càng đắt, nên latency tăng theo cấp số nhân.

### 2.4 Baseline prompt của một câu “chào”

Session `20261107-171730-0cbc`:

| Thành phần | Token |
|---|---|
| Message content | 5.477 |
| Tool schema (46 MCP + prompt-gate + built-in) | **~20.322** |
| **Tổng input** | **25.799** |

Mỗi lượt gọi đều trả giá cho ~20k token schema, kể cả khi không dùng tool nào. Với 40 lượt, riêng schema đã là ~800k token.

---

## 3. Nguyên nhân gốc

Xếp theo mức độ ảnh hưởng.

### RC-1 — Prune lịch sử mỗi bước, phá KV-cache (Critical, nghiêm trọng nhất)

**Vị trí:**

- `src/context/context.ts`: `KEEP_RECENT_TOOL_RESULTS = 20`; `trimHistory()` sửa tool result cũ **in-place** (khoảng dòng 72–83).
- `src/agent/guardrails.ts` (khoảng dòng 331–338): `historyTrimRule` **luôn** trả `{ kind: "trim" }`.
- `src/agent/run-loop.ts` (khoảng dòng 359): gọi `trimHistory()` **sau mỗi bước**.

**Cơ chế:** từ bước thứ 21 trở đi, gần như **mỗi lượt đều làm prefix thay đổi**, nên gần như lượt nào cũng prefill lại toàn bộ. Đây là lý do chính của khoảng cách 6 giờ vs 3–5 phút.

**Hướng fix:** không prune mỗi bước; chỉ trim khi vượt ngưỡng token thật; trim theo **block từ đầu** (bỏ hẳn một đoạn) thay vì sửa từng tool result rải rác.

### RC-2 — Baseline prompt quá lớn do MCP tool schema (High)

**Vị trí:** `src/agent/mcp-bridge.ts` (khoảng dòng 28–38): **toàn bộ** tool spec của MCP được merge vô điều kiện.

Session “chào”: 25.799 input token, message content chỉ 5.477 → **~20.322 token là schema**.

**Hướng fix:** lazy-load MCP tool; chỉ gửi schema của tool được allowlist hoặc được chọn theo task; không merge toàn bộ 46 tool.

### RC-3 — Output tool quá lớn, không được tóm tắt (High)

**Vị trí:**

- `src/agent/tool-executor.ts` (khoảng dòng 193–200): `read_file` **được miễn** việc summarize.
- `src/tools/read-file.ts`: mặc định tới 2.000 dòng, clamp 20k ký tự.
- `src/tools/path-safety.ts`: `MAX_OUTPUT_CHARS = 20_000`.
- `web_fetch` mặc định 20k, cho phép tới 100k.
- `run_command`, `grep` cũng trả output lớn.

Một vài lần đọc file là đủ đẩy history lên hàng chục nghìn token, kéo theo prefill đắt và prune sớm.

**Hướng fix:** bỏ ngoại lệ trong `tool-executor.ts`, thêm summarize cho output > ~4k ký tự.

### RC-4 — Đếm token sai, compaction kích hoạt quá muộn (High)

**Vị trí:**

- `estimateTokens()` chỉ đếm message, **không đếm tool schema** → áp lực context bị đánh giá thấp ~20k token.
- `MAX_HISTORY_TOKENS = 90_000`.
- `src/context/compaction.ts`: mặc định `contextWindow: 128k`, trigger 0.8 → ~102k mới nén.
- `src/llm/model-catalog.ts` (khoảng dòng 161–164): model local lạ **fallback 128k**.

Nếu server thật đặt `num_ctx` = 8k hoặc 32k, agent **không bao giờ compact trước khi server tự truncate** — tệ hơn nữa vì truncate của server cũng phá prefix.

**Hướng fix:** cộng cả tool schema vào `estimateTokens()`; lấy context window thật từ server (`/api/show` của Ollama) thay vì fallback 128k.

### RC-5 — Vòng verify và self-review nhân thời gian (Medium–High)

**Vị trí:**

- `src/agent/verification.ts` (khoảng dòng 52–57): chạy **build → test → typecheck → lint**, mỗi bước timeout 600 s (`src/workspace/build.ts`, khoảng dòng 43).
- `selfReview` thêm một lượt LLM nữa.
- Verify có thể chạy lại nhiều lần khi agent “tưởng” đã xong.

Với task code thật, phần này có thể cộng thêm hàng chục phút đến vài giờ, độc lập với vấn đề cache.

**Hướng fix:** cache kết quả verify; không chạy lại build/test nếu input không đổi; cho phép tắt self-review.

### RC-6 — Timeout và tham số request (Medium)

**Vị trí:**

- `src/llm/llm.ts` (khoảng dòng 147): request timeout **120 s**.
- `src/config/config.ts` (khoảng dòng 336, 356): `maxSteps: 40`, `maxTokens: 8192`.

Với prefill 100k+ token trên máy chậm, request có thể timeout rồi retry — càng làm tăng thời gian và token.

---

## 4. Vì sao OpenCode nhanh hơn

| Khía cạnh | OpenCode | app-scoder-agent |
|---|---|---|
| Lịch sử giữa các compaction | Append-only → KV-cache sống | Prune in-place mỗi bước → cache chết |
| Tool mặc định | Ít, nạp theo nhu cầu | 46+ tool MCP nạp sẵn |
| Context window | Dùng đúng window thật của model | Fallback 128k cho model lạ |
| Đếm token | Tính cả prompt/tool | Chỉ tính message |
| Kích hoạt compaction | Theo ngưỡng thực tế | Muộn ~20k token |

Điểm mấu chốt: OpenCode **không sửa prefix**. Nó chỉ cắt khi thật sự cần, và thường cắt theo kiểu bỏ hẳn một đoạn đầu rồi chấp nhận một lần prefill, thay vì sửa rồi prefill lại liên tục.

---

## 5. Cách kiểm chứng nhanh trên máy

1. **Đo prefill thật** của server:
   ```bash
   ollama run qwen3.6:35b --verbose
   ```
   hoặc xem log llama.cpp: tìm `prompt eval time`, `eval time`, `n_past`.
2. **Chạy lại session nhỏ** với `--log-level debug`, xem `cachedTokens` có luôn bằng 0 không.
3. **So sánh 2 lượt liên tiếp** trong `events.jsonl`: nếu input token tăng nhẹ nhưng latency nhảy vọt → xác nhận cache invalidation.
4. **Kiểm tra `num_ctx`** của server và so với `compaction.contextWindow` trong config.
5. **Tạm tắt MCP** rồi chạy lại cùng prompt “chào”: input token phải giảm từ ~25k xuống ~5k.

---

## 6. Cấu hình giảm tốc (không cần sửa code)

Trong `~/.scoder/config.json` hoặc config dự án — các khoá dưới đây là khoá
thật của `RcFile` (`src/config/config.ts`), đặt ở cấp cao nhất của file.
(`toolOutputChars`, `mcpSchemaTokens`, `verifyCache`, `contextWindow`,
`mcpTools`, `localProfile` chỉ có nghĩa **sau** khi merge P0–P2; phần còn lại
dùng được ngay trên bản 0.9.8.)

```jsonc
{
  // P1-1: ngân sách history/compaction tính theo window THẬT của server
  "contextWindow": 32768,          // = num_ctx (Ollama) / max_model_len (vLLM)
  "compaction": {
    "contextWindow": 32768,        // hoặc đặt trực tiếp trong compaction
    "trigger": 0.55
  },

  // P0-2 / P0-3 / P2-3: output tool nhỏ hơn, có trần schema, timeout đủ dài
  // cho một lần prefill 30k token
  "limits": {
    "toolOutputChars": 6000,       // ngân sách cho MỘT tool result trong history
    "maxOutputChars": 6000,        // trần output thô của một tool call
    "mcpSchemaTokens": 6000,       // 0 = tắt trần (mặc định toàn cục)
    "requestTimeoutMs": 600000
  },

  // P2-1 / P2-2: số bước và lượt self-review (mỗi bước = một lần prefill)
  "maxSteps": 20,
  "selfReview": false,

  // P1-2: không tái sử dụng kết quả verify (mặc định đã cache khi code không đổi)
  "verifyCache": false,

  // P0-3: allowlist toàn cục trên tên mcp__<server>__<tool>
  "mcpTools": {
    "include": ["mcp__github-mcp__get_me", "mcp__github-mcp__search_code"],
    "exclude": ["mcp__github-mcp__*codespaces*", "mcp__github-mcp__*notifications*"]
  }
}
```

> **Lưu ý:** `repoMap` và `snapshots` **không** cần tắt — repo map nằm trong
> system prompt (prefix ổn định, không phá KV-cache), snapshots là git ops cục
> bộ không tốn token. Hai khoá `"agent": {...}`, `"features": {...}`,
> `"llm": {...}` và `"tools": {...}` ở bản trước của plan **không tồn tại**
> trong schema rc; agent được chọn bằng `"agent": "build"` (tên, không phải
> object) và tool allowlist per-server dùng `"mcpServers.<name>.tools"`.

Cách "hạt nhân" để tắt hẳn một MCP server (khi task không liên quan GitHub):

```jsonc
{
  "mcpServers": {
    "github-mcp": { "enabled": false }
  }
}
```

**Kỳ vọng:** input token mỗi lượt giảm 3–5 lần, latency giảm mạnh vì history
ngắn hơn, đúng window, và không còn bị prune mỗi bước.

### 6.1. Sau khi fix (P0–P2 đã merge) — cấu hình tối thiểu

`baseUrl` trỏ về host loopback (`localhost`, `127.0.0.1`, `::1`, `*.local`) thì
agent tự áp **local profile** (`src/config/config.ts: applyLocalProfile`):
`maxSteps` 24 (chỉ hạ khi user chưa đặt), `limits.requestTimeoutMs` 600000,
`limits.toolOutputChars` 6000, `limits.mcpSchemaTokens` 6000, `selfReview` false.
Tắt bằng `"localProfile": false`; key đặt tường minh luôn thắng.

---

## 7. Kế hoạch fix

### P0 — Bắt buộc (giải quyết phần lớn vấn đề)

- [x] **P0-1: Stable prefix / append-only history.**
      Không gọi `trimHistory()` sau mỗi bước. Chỉ trim khi vượt ngưỡng token thật, và trim theo block từ đầu (bỏ hẳn N message/tool result cũ) thay vì sửa in-place từng tool result.
      - `src/agent/guardrails.ts`: `historyTrimRule` trả `trim` **có điều kiện** — chỉ khi `ctx.historyPressure.over`; thiếu field thì rule không fires (an toàn theo hướng không phá cache).
      - `src/agent/run-loop.ts`: TrimGuardrail được gọi qua `applyTrim(budget, force)` + cooldown `TRIM_COOLDOWN_STEPS = 3` bước; log `context_trim` khi số message giảm.
      - `src/context/context.ts`: `trimHistory()` **trả nguyên mảng** khi dưới ngân sách; thứ tự lớp = count cap → prune một lô tool result cũ → bỏ block từ đầu. Điểm cắt không nằm sau assistant có `tool_calls` và không phải `tool`; system + task đầu được bảo vệ. Hysteresis `TRIM_RECOVERY_FRACTION = 0.7` (cắt tới 70% ngân sách để thưa số lần trim). `historyPressure()` short-circuit theo char count và đọc cả shape OpenAI `{function:{name,arguments}}` (JSONL resume).
- [x] **P0-2: Cap + summarize output tool.**
      `src/tools/read-file.ts` cắt theo **dòng** tại `min(limits.toolOutputChars, MAX_OUTPUT_CHARS)` và in footer chỉ định dòng còn lại + `read_file({"path":…,"offset":N})` — "do NOT re-read from the start". `tool-executor.ts` bỏ ngoại lệ `read_file` (giữ nguyên exemption là sai hướng), tool khác đi qua `summariseOutput(…, min(budget, 4000))`; MCP output dùng `clamp()` theo `limits.maxOutputChars`. read_file vẫn là "lưới an toàn": summariser chỉ can thiệp khi output > 1.5× ngân sách.
- [x] **P0-3: Allowlist MCP tool (thay vì lazy meta-tool).**
      **Deviation:** KHÔNG làm lazy/meta-tool discovery — tool thật sự gọi qua MCP mới đi qua `mcpServers.<name>.tools` + permission check (`trust`, readonly); một meta-tool kiểu `mcp_search` sẽ quảng cáo schema động và đi vòng ngoài các check đó. Thay vào đó:
      - `src/mcp/tool-filter.ts` (mới): `matchToolPattern` / `toolAllowed` / `filterToolNames` — glob trên `mcp__<server>__<tool>`; dùng chung cho `McpManager.filterToolDefs` (per-server) và khoá rc mới `mcpTools` (toàn cục).
      - `src/agent/mcp-bridge.ts`: `capMcpSchemaTokens()` + `governedMcpSpecs()` — trần token `limits.mcpSchemaTokens` (mặc định **0 = tắt**; local profile bật 6000), giữ theo thứ tự khai báo tới khi hết ngân sách, warn **một lần** mỗi signature `(cap:dropped)`. `rebuildToolList()` và `Agent.run()` dùng chung `governedMcpSpecs()` — nếu không, run nối tiếp trên cùng Agent (MCP đã connect, `connectMcp()` return sớm) sẽ gửi lại đủ 53 tool.

### P1 — Quan trọng

- [x] **P1-1: Đếm token chính xác.**
      `estimateTokens(msgs, extraTokens)` + `estimateSchemaTokens(tools)` (WeakMap cache theo mảng spec) + `shouldCompact(msgs, cfg, extra)`; ngân sách history = `historyTokenBudget(window, fixedTokens, outputReserve)` = `window*0.95 − schema − maxTokens`. `src/llm/context-probe.ts` (mới): `num_ctx` từ Ollama `/api/show`, `n_ctx` từ llama.cpp `/props`, `max_model_len` từ vLLM — chỉ áp dụng khi rc chưa đặt `contextWindow`; warn nếu schema > 50% window.
- [x] **P1-2: Cache kết quả verify.**
      `src/workspace/fingerprint.ts`: sha1 trên (path, size, mtime) của `fileIndex(workdir, /*force*/ true)` — bắt buộc `force` vì index cache một slot TTL 5s. Kết quả chỉ cache **trong một run** (Map trong Agent), **chỉ khi PASS**; `verifyCache: false` để tắt; log `build` kèm `cached: true`. `runBuild(..., timeoutSecs)` dùng `limits.buildTimeoutSecs` (mặc định 600s).
- [x] **P1-3: Log metrics.**
      `normalizeUsage()` nâng `prompt_tokens_details.cached_tokens` (cả đường streaming); `src/llm/prompt-metrics.ts` băm từng message → `prefixReused` / `commonPrefixMessages`; `chatWithStream` là wrapper đo TTFT; mỗi lượt ghi `llm_usage.perf {ttftMs, callMs, prefillTokPerSec, promptChars, promptHash, historyHash, prefixReused, commonPrefixMessages}` vào JSONL.

### P2 — Tối ưu thêm

- [x] **P2-1:** `applyLocalProfile` hạ `maxSteps` xuống 24 cho model cục bộ — **chỉ khi user không đặt tường minh**. Không thêm cấu hình "theo loại task" (chưa có bằng chứng cần).
- [x] **P2-2:** Tắt `selfReview` cho local model. **Deviation:** KHÔNG tắt `repoMap`/`snapshots`: repo map nằm trong system prompt → prefix cố định, không phá KV-cache và tiết kiệm nhiều vòng `grep`/`read_file` hơn mức 2–3k token nó chiếm; snapshots là git ops cục bộ, 0 token. Profile cũng chỉ bật khi `baseUrl` là host loopback (`isLocalBaseUrl`) — cloud không bị ảnh hưởng.
- [x] **P2-3:** `limits.requestTimeoutMs` = 600000 trong local profile (mặc định toàn cục vẫn 120000).
- [x] **P2-4:** Benchmark trước/sau — xem §8.1 (`scripts/measure-mcp-schema.mjs`, `scripts/bench-context.mjs`).

---

## 8. Acceptance criteria

| Metric | Hiện tại (trước fix) | Mục tiêu | Sau fix (đã đo được) |
|---|---|---|---|
| Input token cho prompt “chào” | ~25.800 (trong đó ~20.300 schema — session `20261107-171730-0cbc`) | < 8.000 | Schema đo lại hôm nay: 16.222 → **8.570** khi `mcpSchemaTokens=6000` (53 → 24 tool). Part "message content" ~5.500 không đổi ⇒ prompt “chào” ≈ **14.100**; muốn <8k phải dùng kèm `mcpTools.include` hoặc `enabled:false` |
| `cachedTokens` mỗi lượt | 0 (không đọc được từ usage) | > 0 sau lượt đầu | Đã chuẩn hoá `prompt_tokens_details.cached_tokens` + log `prefixReused`; **cần đo lại trên máy thật** |
| Latency/lượt sau bước 20 | ~141 s | < 20 s (cùng hardware) | Simulation: wasted prefill −85 % ở P0-1, −95 % sau P0-1+P0-2 → lượt 28 lẽ ra ~30 s thay vì 138 s; **cần xác nhận bằng run thật** |
| Tỉ lệ input/output | ~447:1 | < 50:1 | Tổng prompt token của run 40 bước −39 % (2.322.289 → 1.419.600) |
| Thời gian task mẫu | ~6 giờ | < 30 phút | Chưa chạy lại đúng task mẫu trên local model. Ước tính từ §8.1: token thật sự phải prefill lại giảm ~95 % (1,13M → 53k cho 40 bước) ⇒ ~75 phút phần LLM → cỡ 5–10 phút ở 350 tok/s. **Chưa chốt: phải đo lại trên đúng máy đó.** |

Đo bằng cùng session/prompt trên cùng máy và cùng `num_ctx`.

### 8.1 Số liệu đo được sau fix (12/11/2026)

**Chi phí schema mỗi lượt** — `node scripts/measure-mcp-schema.mjs` (wire JSON, `gpt-tokenizer`):

| Thành phần | Token |
|---|---|
| 13 built-in tool | 2.245 |
| MCP 53 tool (`github-mcp` 11.773 + `prompt-gate` 1.885 + resources 368) | 13.977 |
| **Tổng baseline** | **16.222** |
| Sau `limits.mcpSchemaTokens = 6000` (giữ 24/53 tool, bỏ 29) | **8.570** (MCP 6.325) — tiết kiệm **7.652 token/lượt** |

**Chiến lược history** — `node scripts/bench-context.mjs` (mô phỏng deterministic 40
bước, một task, prefill 1.000 tok/s; `wastedPrefill` = token đã gửi nhưng phải tính
lại vì prefix đổi):

| Kịch bản | Strategy | prompt | wastedPrefill | cacheHit | trim |
|---|---|---|---|---|---|
| A. window 128k, compaction tắt, 16.222 schema | legacy (trim mỗi bước, read_file 20k) | 2.322.289 | 1.134.805 | 0.511 | 20 |
| A | chỉ P0-1 | 2.605.701 | 173.665 (−85 %) | 0.933 | 1 |
| A | P0-1 + P0-2 (read_file 6k) | 1.419.600 | 52.533 (−95 %) | 0.963 | 0 |
| B. window 32k (num_ctx Ollama), compaction bật | legacy | 908.392 | 224.107 | 0.753 | 38 |
| B | P0-1 + P0-2 | 857.056 | 69.273 (−69 %) | 0.919 | 9 |
| C. window 32k + local profile (schema 6k) | legacy | 790.920 | 481.386 | 0.391 | 35 |
| C | P0-1 + P0-2 | 718.183 | 80.963 (−83 %) | 0.887 | 4 |

Đọc bảng A: P0-1 một mình làm history **dài hơn** (prompt 2.605.701 > 2.322.289 — vì
không còn prune rải rác), nhưng thời gian thật giảm gần 10 lần vì prefix không bị phá.
P0-2 là phần kéo history về kích thước hợp lý. Ở kịch bản B/C compaction không kích
hoạt (peak history thấp hơn trigger) — không có delta compaction để báo cáo.

Quy đổi theo log baseline (§2.2): prefill lãng phí 1.134.805 token ≈ 1.135 s ở
1.000 tok/s, so với 52.533 token ≈ 53 s sau fix.

**Regression guard:** `npm test` = 942/942 unit + e2e + MCP smoke; `npm run
typecheck` sạch; `npm run lint` 0 error (22 warning baseline); `npm run
check:layers` ✓. Test mới: `test/perf-p0-p1.test.mjs` (16 case cho P0-2/P0-3/P1-1/P1-2/P1-3),
`test/core.test.mjs` thêm case trim (identity khi dưới ngân sách, hysteresis no-op,
 orphan-safe cut), `test/guardrails.test.mjs` cho history-trim có điều kiện,
`test/limits.test.mjs` hermetic qua `SCODER_CONFIG`.

**Chưa đo:** run thật trên `qwen3.6:35b` cùng task mẫu (§10) — cần máy đó, cùng
`num_ctx`, rồi so `llm_usage.perf` (`prefixReused`, `cached_tokens`) giữa hai session.

---

## 9. Lưu ý bảo mật

`~/.scoder/config.json` đang chứa **API key GitHub và prompt-gate dạng plaintext**. Nên chuyển sang biến môi trường hoặc keychain trước khi chia sẻ config/log.

---

## 10. Phụ lục — Timeline session mẫu

```
Lượt 1–27   : 5,3 phút   (11,9 s/lượt)  — cache còn hiệu lực
Lượt 28–50  : 54,1 phút  (141,3 s/lượt) — sau khi tool result #21 bị prune
Tổng        : ~59,4 phút cho 40 lượt gọi LLM (chưa tính tool execution)
Token       : 1.585.575 input / 3.547 output / 0 cached
```

Ghi chú: con số ~6 giờ là chiếu theo throughput prefill ~73 token/s của máy chậm hơn; session log mẫu chạy ở ~350 token/s nên chỉ mất ~75 phút cho phần LLM.

---

## 11. Kết quả implement

### 11.1 Bản đồ thay đổi

| Fix | File | Điểm cần biết khi review |
|---|---|---|
| P0-1 | `src/context/context.ts` | `trimHistory` trả **đúng array cũ** khi dưới ngân sách (identity — test dựa vào tính chất này); `historyPressure()` char short-circuit; `PRUNED_TOOL_RESULT`, `TRIM_RECOVERY_FRACTION` export |
| P0-1 | `src/agent/guardrails.ts` | `historyTrimRule` cần `ctx.historyPressure`; thiếu → không fires |
| P0-1 | `src/agent/run-loop.ts` | `applyTrim(budget, force)`, `TRIM_COOLDOWN_STEPS = 3`, log `context_budget` / `context_trim` |
| P0-2 | `src/tools/read-file.ts`, `src/tools/path-safety.ts`, `src/agent/tool-executor.ts` | cap theo dòng + footer offset; `setMaxToolOutputChars` cho test/rc |
| P0-3 | `src/mcp/tool-filter.ts` (mới), `src/agent/mcp-bridge.ts`, `src/mcp/manager.ts` | `governedMcpSpecs()` là cửa duy nhất cho MCP tools (cả `run-loop` lẫn `run()`) |
| P1-1 | `src/context/compaction.ts`, `src/llm/context-probe.ts` (mới), `src/config/config.ts` | `historyTokenBudget(window, fixed, reserve)`; probe chỉ chạy khi rc không đặt `contextWindow` |
| P1-2 | `src/agent/verification.ts`, `src/workspace/fingerprint.ts` (mới), `src/workspace/build.ts` | cache in-memory per run; chỉ PASS |
| P1-3 | `src/llm/prompt-metrics.ts` (mới), `src/llm/llm.ts`, `src/agent.ts` | `llm_usage.perf`; `Agent.lastPromptRef` giữ hash lượt trước |
| P2 | `src/config/config.ts` | `isLocalBaseUrl`, `LOCAL_PROFILE_DEFAULTS`, `applyLocalProfile` |
| Docs | `docs/performance.md`, `docs/configuration.md`, `docs/mcp.md`, `docs/guardrails.md`, `.scoderrc.example.json` | — |

### 11.2 Deviation so với §7 (và lý do)

1. **P0-3 không làm lazy meta-tool.** Meta-tool sẽ quảng cáo schema động và đi vòng
   ngoài `mcpServers.<name>.tools` + permission/`trust` check. Thay bằng allowlist
   tường minh + trần token (mặc định tắt, local profile bật 6k).
2. **P2-2 không tắt `repoMap` và `snapshots`.** Repo map nằm trong system prompt →
   prefix ổn định, không phá KV-cache, và giảm số vòng `grep`/`read_file`; snapshots
   là git ops cục bộ, 0 token. Chỉ tắt `selfReview` (thêm đúng một lượt LLM với
   prompt gần đầy).
3. **P2-1 chỉ hạ `maxSteps` khi user chưa đặt tường minh**, và chỉ khi `baseUrl` là
   host loopback — cloud không đổi hành vi.
4. `limits.mcpSchemaTokens` mặc định **0** thay vì một con số "an toàn": giữ đúng
   cam kết trong `docs/performance.md` là mỗi optimization phải đo được và roll-back
   được; local profile là nơi đủ cơ sở để bật 6k.

### 11.3 Roll-back từng món

| Muốn tắt | Đặt |
|---|---|
| Trần schema MCP | `"limits": {"mcpSchemaTokens": 0}` |
| Local profile | `"localProfile": false` |
| Verify cache | `"verifyCache": false` |
| Ngân sách output tool | `"limits": {"toolOutputChars": 20000}` (về trần cũ) |
| Trim chiến lược mới | `historyTrimRule` là rule duy nhất — xoá nó khỏi `DEFAULT_RULES` để trở lại trim mỗi bước, nhưng **đừng**: đây là fix lớn nhất |

`contextWindow` probe: đặt số tường minh là mọi probe bị bỏ qua.

### 11.4 Regression guard cho `aec95ef`

Commit đó sửa hai lỗi UX: `read_file` không được âm thầm bị ép về 4k ký tự, và review-task
không dùng `buildStopRule`. Sau P0–P2:

- `read_file` vẫn trả **đủ dòng** cho tới ngân sách history (`toolOutputChars`),
  không bao giờ âm thầm cắt ở 4k, và nói rõ offset đọc tiếp ⇒ không "đọc lại từ
  đầu bằng cách khác". Test: `P0-2: read_file cắt theo dòng + hint đọc tiếp`
  (`test/perf-p0-p1.test.mjs`).
- `buildStopRule`/review-agent không đổi; guardrail order test vẫn pass.

### 11.5 Cách tự kiểm chứng trên máy

```bash
npm run build && npm test           # 942 unit + e2e + MCP smoke
node scripts/measure-mcp-schema.mjs            # baseline schema
node scripts/measure-mcp-schema.mjs --cap 6000 # projected sau trần
node scripts/bench-context.mjs                 # wasted prefill: legacy vs hiện tại
# Run thật với model local:
#   grep '"type":"llm_usage"' .scoder/logs/<session>.jsonl | jq '.perf'
#   prefixReused: false + cached_tokens: 0 = lượt đó re-prefill toàn bộ
```

