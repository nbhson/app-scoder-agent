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

### 8.2 Đo trên máy thật sau vòng fix thứ hai (13/11/2026)

Bối cảnh: user build xong, chat "chào" vẫn **56 s** và "mất 12k ctx". Máy chạy
llama.cpp (`http://0.0.0.0:8080/v1`), model `Qwen3.6-35B-A3B-UD-IQ2_M`,
**`n_ctx` thật = 16.128**, `total_slots: 2`.

Kết luận: không phải bug trim/schema — hai hiện tượng riêng, đều do chi phí cố
định của một lượt gọi:

| # | Phát hiện (đo bằng `/tokenize`, `prompt_tokens` của server) | Fix đã merge |
|---|---|---|
| 1 | `probeContextWindow` trả `null`: llama.cpp để window ở `default_generation_settings.n_ctx` (không phải top level) và `/props` cần API key → 401. Agent lập kế hoạch trên 128k trong khi server chỉ 16k | probe gửi Authorization, đọc per-slot `n_ctx` (không lấy `total_n_ctx`), `baseUrl.trim()` (rc thật có space thừa), ưu tiên `{base}/models` rồi `{origin}/v1/models`, và **warn** khi server cục bộ không probe được |
| 2 | Prompt "chào" = **14.480 token**: schema 37 tool ≈ **10.320**, system prompt **4.156** (riêng repo map 2.561), task 2. Ước lượng cl100k chỉ ra 8.065 cho schema — thiếu ~22 % vì không tính token đóng gói ChatML (13 builtin: ước 2.086, thật 2.098 phần content nhưng tổng overhead 2.876) | `fixedPromptTokens()` = max(ước lượng, **số đo thật** `prompt_tokens − estimateTokens(messages)`), log `fixedSource: "measured"`; self-invalidating khi tool list đổi |
| 3 | `outputReserve` = `maxTokens` 8.192 ăn half window 16k ⇒ `historyTokenBudget` rớt sàn 2.000 ⇒ trim gần như mỗi bước (đúng cái P0-1 tránh) | trần reserve = 25 % phần còn lại ⇒ budget 2.000 → 5.442 (37 tool) / 7.269 (24 tool) |
| 4 | `mcpSchemaTokens: 6000` là con số tuyệt đối, không nhìn window: 6k schema + 4k system = 10k trên server 16k | `SCHEMA_SHARE_OF_WINDOW = 0.35`: cap hiệu dụng = min(rc, 35 % window − builtin schema). 16k ⇒ 6.000 → **3.558** ⇒ giữ 11/53 MCP tool, tổng 24 tool |
| 5 | `promptChars` log đếm chuỗi hash chứ không đếm nội dung ⇒ không trả lời được "12k từ đâu ra" | tách `messageChars` / `schemaChars` + `fixedTokens` trong `llm_usage.perf` |

**Số liệu sau fix** (cùng lệnh `chào`, cùng server, `--log-file`):

| Mốc | input tokens | tools | cached | TTFT | total |
|---|---|---|---|---|---|
| Trước (session `20261113-000525-e1ed`, 53 tool, cold) | ~14.480 | 53 | 0 | — | **53–56 s** |
| Sau P0–P2, cold (37 tool) | 14.480 | 37 | 0 | 36–38 s ở 11k token ⇒ ≈300 tok/s | 44 s |
| Sau vòng 2, warm (37 tool, `n_ctx` đã probe đúng) | 14.480 | 37 | 14.476 | 0,12–0,15 s | **4,5–5,5 s** |
| Sau vòng 2, cap theo window (24 tool) | **11.315** | 24 | — | 0,15 s warm | **4,5–6,9 s** |

56 s → 44 s → 4,5–6,9 s: phần lớn 56 s là **prefill lạnh 14,5k token**, không phải
history trim. Hai hệ quả thực tế cho máy này:

- 90 % window bị chi phí cố định chiếm ⇒ muốn chat ngắn phản hồi nhanh phải giảm
  tool: `"mcpTools": {"include": [...]}`, `"mcpServers": {"github-mcp": {"enabled": false}}`,
  hoặc `"repoMap": false` (tiết kiệm 2.561 token).
- `total_slots: 2` làm request rải slot nên prefix cache chỉ reuse khi trùng slot;
  chạy server với `-np 1` nếu muốn warm ổn định. Không có API clear cache slot
  (`POST /slots {"action":"clear"}` → 404), muốn đo cold phải restart server.

**Regression guard vòng 2:** `npm test` = 953/953 (thêm 11 case: probe qua
`node:http` mock `/props`+`/api/show` có API key, per-slot precedence, baseUrl
có space, budget clamp, window-aware cap, calibration `measured`/`estimate`);
typecheck sạch, lint 0 error (23 warning baseline), check:layers ✓ (372 imports),
docs:check ✓.

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
| P1-1 (vòng 2) | `src/llm/context-probe.ts` | gửi Authorization (llama.cpp chặn `/props` bằng 401), đọc `default_generation_settings.n_ctx` per-slot, `baseUrl.trim()`, vLLM thử `{base}/models` trước `{origin}/v1/models` |
| P1-1 (vòng 2) | `src/agent.ts` → `fixedPromptTokens()` / `fixedPromptSource()` | chi phí cố định = max(ước lượng schema, `prompt_tokens − estimateTokens(messages)` lượt trước); self-invalidating khi tool list đổi (`setTools`) |
| P1-1 (vòng 2) | `src/agent/mcp-bridge.ts` → `effectiveMcpSchemaCap()` | `SCHEMA_SHARE_OF_WINDOW = 0.35`, sàn `MIN_SCHEMA_CAP_TOKENS = 1200`; `governedMcpSpecs` là chỗ duy nhất áp trần |
| P1-1 (vòng 2) | `src/context/context.ts` | reserve ≤ 25 % phần còn lại sau schema; `MIN_HISTORY_TOKENS` export |
| P1-3 (vòng 2) | `src/llm/prompt-metrics.ts`, `src/agent.ts` | `messageChars` / `schemaChars` là char THẬT (trước đây `promptChars` đếm chuỗi hash); `llm_usage.perf.fixedTokens/fixedSource` |
| P1-2 | `src/agent/verification.ts`, `src/workspace/fingerprint.ts` (mới), `src/workspace/build.ts` | cache in-memory per run; chỉ PASS |
| P1-3 | `src/llm/prompt-metrics.ts` (mới), `src/llm/llm.ts`, `src/agent.ts` | `llm_usage.perf`; `Agent.lastPromptRef` giữ hash lượt trước |
| P2 | `src/config/config.ts` | `isLocalBaseUrl`, `LOCAL_PROFILE_DEFAULTS`, `applyLocalProfile` |
| Docs | `docs/performance.md`, `docs/configuration.md`, `docs/mcp.md`, `docs/guardrails.md`, `.scoderrc.example.json` | `docs/performance.md` có mục "Where the tokens go" + "Cold vs warm" |

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
5. **Vòng 2 tự siết trần MCP theo window (`SCHEMA_SHARE_OF_WINDOW`)** — đây là lần
   duy nhất agent giữ ít tool hơn con số user ghi trong rc. Lý do: 6k là trần tuyệt
   đối, còn trên window 16k thì 6k schema + 4k system prompt = 90 % context. Vẫn
   opt-out được bằng `"mcpSchemaTokens": 0`, và agent in một dòng warn nêu rõ trần
   bị hạ từ bao nhiêu xuống bao nhiêu.
6. **Vòng 2 dùng `prompt_tokens` của engine làm sự thật** thay vì tin bộ đếm. Rủi ro
   duy nhất là engine báo sai ⇒ budget chặt hơn mức cần (an toàn hơn là lỏng).
   Số đo bị loại khi `prompt_tokens − estimateTokens(messages) <= 0`.

### 11.3 Roll-back từng món

| Muốn tắt | Đặt |
|---|---|
| Trần schema MCP | `"limits": {"mcpSchemaTokens": 0}` |
| Local profile | `"localProfile": false` |
| Verify cache | `"verifyCache": false` |
| Ngân sách output tool | `"limits": {"toolOutputChars": 20000}` (về trần cũ) |
| Tự siết trần MCP theo window | `"limits": {"mcpSchemaTokens": 0}` (tắt luôn trần) — hoặc đặt `"contextWindow"` lớn để 35 % không binding |
| Calibration từ `prompt_tokens` | `fixedPromptTokens()` luôn là `max(ước lượng, số đo)`; muốn vô hiệu, đặt `contextWindow` tường minh và tắt MCP cap — hoặc sửa `Agent.fixedPromptTokens()` trả `estimateSchemaTokens(this.tools)` (một dòng) |
| Probe window | đặt `"contextWindow"` tường minh trong rc |
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
npm run build && npm test           # 959 unit + e2e + MCP smoke
node scripts/measure-mcp-schema.mjs            # baseline schema
node scripts/measure-mcp-schema.mjs --cap 6000 # projected sau trần
node scripts/bench-context.mjs                 # wasted prefill: legacy vs hiện tại
# Run thật với model local (cần --log-file hoặc SCODER_LOG_FILE=1):
SCODER_NO_APIKEY_WARNING=1 node dist/index.js --log-file --no-save -y "chào"
#   grep '"type":"context_window"' .scoder/logs/<session>.jsonl  → n_ctx thật của server
#   grep '"type":"context_budget"' .scoder/logs/<session>.jsonl  → tools / trimBudget / fixedSource
#   grep '"type":"llm_usage"' .scoder/logs/<session>.jsonl | jq '.usage, .perf'
#     cached_tokens: 0 + ttftMs lớn   = lượt đó prefill lại toàn bộ (cold)
#     cached_tokens ≈ input_tokens    = KV-cache reuse tốt (warm)
#     fixedSource "measured"          = budget đang theo số đo thật của engine
# Server thật, để tự kiểm tra estimator:
#   curl -s -H "Authorization: Bearer $KEY" localhost:8080/props | jq '.default_generation_settings.n_ctx, .total_slots'
```


---

## 12. Phát hiện thêm: sidebar TUI hết realtime từ câu hỏi thứ hai

Báo cáo của user (13/11/2026): sau lượt generate đầu, sidebar vẫn chạy realtime;
từ câu hỏi thứ 2 trở đi thì đứng im.

**Chẩn đoán** (mô phỏng đúng reducer trong `src/tui/state.ts`, không cần mở TUI):

| Mốc | `startedAt` | `endedAt` | sidebar hiển thị |
|---|---|---|---|
| hết câu 1 (`finish`) | mốc câu 1 | đóng | elapsed = đúng thời lượng câu 1 |
| giữa câu 2 (chỉ `step` + `llm_delta`) | **vẫn mốc câu 1** | **vẫn đóng** | elapsed đóng băng, usage/ctx/tok-s không đổi |

Nguyên nhân: sidebar METRICS lấy anchor từ event `run_start`:

```ts
elapsedMs = (state.endedAt ?? Date.now()) - state.startedAt
```

nhưng `run_start` chỉ `run()` phát (`src/agent.ts:1041`). `runTurn()` — đường đi
của mọi câu hỏi từ thứ 2 trong TUI/REPL — nhảy thẳng vào `runLoop()`, nên
`endedAt` của lượt trước không được mở lại ⇒ `(endedAt ?? now)` luôn là
`endedAt` ⇒ mọi con số theo thời gian đứng im. Các field cùng reset trong nhánh
đó (`usage`, `context`, `phases`, `queue`, `subagents`, `verification`,
`lastLlmTokPerSec`, `guardrailCount`) cũng rò rỉ sang lượt mới. `resume()` cùng
lỗi (không stamp `run.started` vào event log, chỉ append thô).

**Fix** — gộp dấu mốc run vào một hàm `Agent.emitRunBoundary()`, dùng cho cả
ba entry point:

| Entry point | `run_start.task` | quiet | Ghi chú |
|---|---|---|---|
| `run()` | nguyên văn user gõ (trước `expandMentions`) | — | `run.started` trong event log vẫn ghi task đã expand (nội dung model thực thấy) |
| `runTurn()` | nguyên văn user gõ | — | hết lỗi; đồng thời stamp `run.started` để event log liền mạch |
| `resume()` | `currentTask` (task gốc) | `true` | transcript đã restore ⇒ reducer không append lại dòng user |

Vì `runTurn` giờ phát `run_start` với đúng text user vừa gửi, dedupe sẵn có
trong reducer (`last.kind === "user" && last.text === ev.task`) chặn nhân đôi
dòng chat — không cần thay đổi `use-submit` ngoài comment mô tả lại.

**Test:**
- `test/trim-turn.test.mjs` — 3 case: 2 event `run_start` cho run+runTurn (và
  tới trước `step` đầu tiên của lượt), 2 dòng `run.started` trong event log,
  `resume()` phát `run_start` với `quiet: true`.
- `test/tui-sidebar.test.mjs` — 3 case reducer: `run_start` lượt 2 mở `endedAt`
  + reset usage/context/tok-s; chứng minh hành vi cũ đóng băng; `quiet` không
  append dòng user nhưng vẫn reset anchor.

**Bài học khi test đồng hồ:** phiên chạy full suite đầu tiên fail đúng 1 case —
`assert.notEqual(run_start2.startedAt, run_start1.startedAt)` vì reducer gọi
`Date.now()` và hai event nằm trong cùng một millisecond (standalone thì qua
vì có thời gian khởi động module). Các test liên quan `startedAt`/`endedAt` vì
thế dùng đồng hồ nhân tạo (`withFakeClock`: ghim `Date.now()` rồi `tick(ms)`),
vừa tất định vừa kiểm được cả giá trị elapsed tuyệt đối.

**Cổng vòng 3:** `npm test` = 959/959 (+6 case so với vòng 2), typecheck sạch,
lint 0 error (23 warning baseline), `check:layers` ✓, `docs:check` ✓.

**Lưu ý khi review code liên quan UI:** bất cứ đường nào vào `runLoop()` đều
phải đi qua `emitRunBoundary()`. Thêm entry point mới (ví dụ "retry from step
N") mà quên nó thì triệu chứng không phải lỗi crash mà là UI chạy sai im lặng.

---

## 13. So sánh với OpenCode trên CÙNG engine: vì sao nhanh/ổn định hơn, và 14k có bắt buộc không?

**Câu hỏi của người dùng:** model local thì OpenCode chạy nhanh và "ổn định" hơn
scoder; scoder mở màn đã ~11–14k token — giảm được không hay đó là bắt buộc?

**Cách đo (không suy đoán):** `scripts/capture-prompt-proxy.mjs` đứng giữa agent
và llama.cpp, ghi lại ĐÚNG request body + `usage` + ttft của phản hồi;
`scripts/measure-prompt-anatomy.mjs` replay các body đó vào engine với
`max_tokens: 1` để lấy `prompt_tokens` và `prompt_tokens_details.cached_tokens`
— số engine tự đếm, cùng tokenizer, cùng chat template, cho cả hai agent.
Cùng model `qwen3.6:35b`, cùng workdir, cùng task `chào`, config thật của từng
agent. OpenCode chạy `opencode run --standalone` (bản 2.2.7) — bắt buộc
`--standalone` vì dịch vụ nền `opencode serve --service` bỏ qua config theo lệnh.

### 13.1 Chi phí cố định của lượt đầu tiên

| case | tools trong request | schema | system | `prompt_tokens` |
|---|---|---|---|---|
| scoder, MCP tắt | 13 | 2,876 | 4,099 | **6,993** |
| OpenCode, MCP tắt (config tối giản) | 13 | 3,835 | 4,725 | **8,578** |
| scoder, MCP bật (đúng `~/.scoder/config.json`) | 24 (sau trần schema) | 7,139 = builtin 2,876 + MCP 4,263 | 4,169 | **11,309** |
| OpenCode, MCP bật (đúng `opencode.jsonc`) | 13 | 3,835 | 3,114 | **6,968** |

Lưu ý tính công bằng: hai dòng OpenCode đo ở hai môi trường khác nhau — dòng
"MCP tắt" dùng config tối giản tôi tự viết (OpenCode vẫn quảng bá ~39 dòng skill
list ≈ 1,6k token), dòng "MCP bật" chạy với `XDG_CONFIG_HOME` sạch nên **không**
có skill list. Vì vậy so sánh "cùng quảng bá skill" phải cộng thêm ~1,6k cho dòng
cuối: OpenCode ≈ 8,5k. Khoảng cách với scoder vẫn là ~2,8k token và nó nằm
đúng ở phần schema MCP (13.2b), không phải ở docs.

Kết luận từ bảng: khi **cùng tắt MCP**, OpenCode nặng hơn scoder 1,585 token
(8,578 vs 6,993) — nên "cắt prompt cho giống OpenCode" không phải hướng đi.
Khi **cùng bật MCP**, OpenCode nhẹ hơn scoder ~2,8–4,3k token, và toàn bộ
khoảng cách nằm ở đúng một thứ: scoder gửi JSON schema của tool MCP trong mọi
request, OpenCode thì không.

### 13.2 Ba khác biệt thật, đo được

**(a) Số lần prefill cho một lượt chat.** Với `chào`, scoder có thể tốn **hai**
lần gọi model: 6,993 + 7,069 = 14,062 token (~56s). Lý do: loop chỉ kết thúc
khi model in ra marker `<<CHAT_DONE>>` (rule `chat-done`) hoặc khi đã
`textOnlyStreakLimit = 2` bước chỉ-text — model local hay quên marker nên
đường "2 bước" mới là đường thường đi, và bước 2 = một lần prefill full.
OpenCode kết thúc ngay khi không có tool call ⇒ đúng 1 lần prefill.
(OpenCode có gửi thêm một request nhỏ ~2.1KB không tools cho việc đặt tiêu đề
session — phụ, không đáng kể so với 30s.)

**(b) MCP không nằm trong `tools[]` phía OpenCode.** kể cả khi config khai báo
`mcp.servers.github-mcp` (46 tool) + `prompt-gate`, request vẫn chỉ 13 tool:
OpenCode quảng bá tool MCP dưới dạng **catalog text** trong system prompt
(khối `# Code Mode`) rồi gọi qua một tool `execute` duy nhất. scoder gửi
full JSON schema ⇒ 4,263 token cho 11 tool được giữ sau trần; hai tool
`prompt-gate` một mình đã ~1,8k token. Đây là chỗ scoder đắt hơn hẳn và là
chỗ cắt có ích nhất cho các task không cần bên ngoài.

**(c) Prefix của scoder đổi theo trạng thái repo.** REPO MAP (2,558 token)
render "N files" + kích thước từng file. Bằng chứng thực nghiệm: thêm đúng một
file 900 byte vào repo ⇒ map đổi "315 files" → "316 files", `promptHash` đổi
`77c186f6` → `bc07a25f`, `cached_tokens = 0`, ttft 30,145ms. OpenCode không có
nội dung dễ đổi kiểu đó trong fixed prompt (nên prefix của nó sống được qua
nhiều phiên). Lưu ý: trong MỘT run, map chỉ build một lần (`buildRunMessages`)
nên các bước trong run vẫn reuse tốt — vấn đề nằm ở **giữa các run/lượt mới**.

### 13.3 "Ổn định" = KV-cache, không phải prompt nhỏ

| phép đo (engine tự báo) | reuse | ttft |
|---|---|---|
| gửi lại đúng 1 request scoder 11,309 tok | 99–100% | **80ms** (có pin slot) / 277–1,487ms |
| gửi lại đúng 1 request OpenCode 8,578 tok | 100% | 74ms (pin) / 658–810ms |
| cold prefill scoder 11,309 tok | 0% | 30,145–37,988ms |
| cold prefill OpenCode 8,578 tok | 0% | 16,264–17,900ms |
| scoder, đổi tools (24 → 3, prompt 5,113 tok) | 0% | 13,737ms |
| llama.cpp 2 slot, 2 prompt xen kẽ, **không** pin | — | **2/6 lượt lạnh** |
| như trên nhưng client gửi `slot_id: 0` | — | **0/6 lượt lạnh**, 75–81ms |

Qua một đêm số liệu thì kết luận rất gọn: **một lượt 11.3k token hoặc tốn
~30–38s hoặc tốn ~0.1s**, tuỳ prefix có được giữ nguyên và có rơi đúng slot
đã cache hay không. "Ổn định" của OpenCode phần lớn là nó ít khi tự làm vỡ
prefix của mình, cộng với ít lần prefill hơn mỗi lượt.

### 13.4 11,309 token đó mua cái gì (đo từng block, không phải estimate)

Hai cách đo cho cùng một đáp số, nên bảng này đáng tin:
- `measure-prompt-anatomy.mjs blocks`: dựng lại message qua đúng
  `buildRunMessages()`, tắt từng nguồn một, replay → hiệu số token.
- thủ tục "nối đuôi": gửi prefix đã được gỡ mọi block động (ấm KV), rồi gửi
  prefix + đúng một block; phần trùng được reuse nên mỗi phép đo chỉ mất
  0.5–9s thay vì 40s.

| thành phần | token | ghi chú |
|---|---|---|
| JSON schema 13 tool builtin | **2,876** | `task` 1,559c / `write_todos` 1,424c là hai mục lớn |
| JSON schema 11 tool MCP (sau trần) | **4,263** | riêng `prompt-gate` ~1,800; `github-mcp` 9 tool ~2,460 |
| REPO MAP (137 dòng, 316 file) | **2,558** | render cả "N files" + kích thước từng file |
| chỉ dẫn lõi (identity/workflow/tools/safety/verification/output) | 954 | sàn thật sự, không cắt được |
| skills advertised | 492 | 2,436c |
| SUBAGENTS | 106 | |
| MCP SERVERS (danh sách tên server) | 59 | |
| message user "chào" + framing ChatML | 7 | đo trực tiếp: system một mình = 4,163 tok, full 0-tools = 4,170 |
| **tổng** | **11,309** | = 4,170 (system+messages) + 7,139 (schema); tổng các Δ block (4,169) khớp 4,163 trong sai số ±6 |

Nhìn theo tỷ lệ: **63% chi phí mở màn là tool schema** (7,139/11,309), trong đó
4,263 là MCP; **23% là REPO MAP**. Phần "hướng dẫn cách làm việc" — thứ mọi
người hay đổ lỗi — chỉ 954 token (8%). OpenCode cũng trả tiền cho docs của nó
(khối `# Code Mode` 2,765 token) nhưng không trả gì cho tool MCP.

### 13.5 Vì sao 11.3k fixed là vấn đề *cấu trúc*, không phải vấn đề tốc độ

- Server: llama.cpp, `n_ctx = 16,128`, 2 slot (`/props`, `/slots`).
- Fixed cost 11,309 ⇒ chỉ còn **4,819** token cho history + output.
- `compaction.trigger = 0.8` ⇒ ngưỡng 12,902 token ⇒ history chỉ còn **~1,593**
  token trước khi compaction chạy. Nghĩa là sau 1–2 tool result là compaction.
- Mỗi lần compaction = thêm MỘT prefill ~7.6k token. Đo trong run thật (task B):
  call #4 `prompt=7,584 cached=440 ttft=38,225ms` — call này rơi vào slot
  không giữ prefix nên trả giá cold full.
- Khép kín vòng xoáy: compaction viết lại history ⇒ prefix bước sau khác ⇒ mất
  reuse ⇒ cold tiếp. Đây chính là cơ chế "6 giờ" còn sót lại, không phải token
  nào bị "thừa" theo nghĩa vô nghĩa.

Vì vậy câu trả lời cho "có bắt buộc 14k ctx không?" là: **không**, và con số
11–14k cũng không phải *trần* mà là *chi phí trả trước*. Trần thật là 16,128
của server. Chọn một trong hai (hoặc cả hai): nâng trần (`--ctx-size 32768`,
`--parallel 1`), hoặc giảm chi phí trả trước xuống ~4–7k như mục 13.6 — cả hai
đều để history đủ sống mà không cần compaction mỗi 2 bước.

### 13.6 Đề xuất, xếp theo tiền đo được

| # | việc | tiết kiệm (đo) | chi phí/rủi ro |
|---|---|---|---|
| P0-7 | **Không quảng bá schema MCP khi task không cần**: intent-gate (chat/đọc repo ⇒ `tools` chỉ builtin), hoặc theo kiểu OpenCode — catalog text + fetch schema khi model gọi | −4,263 tok/lượt (~13s cold, và ~0 khi đã ấm nhưng đỡ vỡ prefix) | model không biết tool MCP tồn tại cho tới khi được "mở"; cần một đường bật động (tool `enable_mcp_tools` hoặc tự mở khi model gọi tên đã quảng bá) |
| P0-8 | **Một lượt chat = một prefill**: step text-only, không tool call, không plan pending ⇒ finish ngay (không đợi `<<CHAT_DONE>>`, không đợi `textOnlyStreakLimit` = 2) | −7,069 tok = −~20s cho mọi câu chào | phải giữ đúng guardrail bắt build khi CÓ sửa file (bài học `aec95ef`) — chỉ nới cho nhánh không sửa gì |
| P0-9 | **Pin `slot_id` khi engine là llama.cpp** (một session một slot) | 2/6 lượt lạnh → 0/6; cold 30s → 80ms | chỉ đúng cho llama.cpp; server nhiều user thì phản tác dụng — bật theo `provider === "openai"` + probe `/slots.total_slots === 1..N` |
| P1-5 | **REPO MAP ra khỏi fixed prompt khi task chat**, hoặc render mà không kèm "N files"+kích thước từng file (nội dung bền) | −2,558 tok và hết cảnh vỡ prefix khi có file mới | mất bớt khả năng "orient" — model phải gọi tool `repo_map`/`list_files` (đã có sẵn) |
| P1-6 | Tool subset theo intent cho chat (bỏ `task`/`write_todos`/`web_fetch`/`load_skill` ≈ 1,000 tok) | −~1,000 tok | model không gợi ý được plan/subagent trong lượt chat (vốn không cần) |
| P1-7 | `compaction.trigger` tính theo **history**, không theo tổng (fixed đã trừ sẵn), hoặc tự nâng trigger khi fixed/window > 0.6 | bỏ ~1 lần compaction mỗi 2 bước | phải chứng minh không vượt trần: history budget = window − fixed − output reserve |

Không đề xuất bắt chước docs của OpenCode: docs của nó còn đắt hơn (2,765 token
cho khối `# Code Mode`), cái nó rẻ hơn là **cấu trúc request** (không MCP
schema) và **stability của prefix**.

### 13.7 Cách tái hiện (và hai giả thuyết đã bị phản chứng)

```bash
# 1) proxy đứng giữa agent và llama.cpp
SCODER_CAPTURE_DIR=/tmp/cap-scoder node scripts/capture-prompt-proxy.mjs 8099 http://0.0.0.0:8080 &
# 2) chạy từng agent với baseUrl trỏ vào proxy (giữ nguyên rc thật)
SCODER_CONFIG=/tmp/cap-scoder/rc.json SCODER_LOG_FILE=1 node dist/index.js -y --no-save "chào"
OPENCODE_CONFIG=/tmp/cap-oc/cfg.json opencode run --standalone --model llama-cpp/qwen3.6:35b "chào"
# 3) đo
node scripts/measure-prompt-anatomy.mjs anatomy /tmp/cap-scoder,/tmp/cap-oc 1
node scripts/measure-prompt-anatomy.mjs blocks  /tmp/cap-scoder 1
node scripts/measure-prompt-anatomy.mjs warmcold /tmp/cap-scoder 1 --reps 3
node scripts/measure-prompt-anatomy.mjs scatter /tmp/cap-scoder 1 4 --pin 0
```

Hai giả thuyết tôi nghiêng về trước khi đo và đã **sai**:

1. *"Compaction gửi `tools: []` làm vỡ toàn bộ prefix."* Phản chứng: cùng
   history, giữ tools = `12,279 tok cached=11,295 (92%)`; bỏ tools =
   `5,140 tok cached=4,156 (81%)`. llama.cpp đặt schema SAU phần messages nên
   bỏ tools chỉ mất đúng phần schema, hệ thống+history vẫn reuse. Cái làm mất
   cache ở call compaction là **rải slot**, không phải `tools: []`.
2. *".scoder/logs mỗi run thêm file vào REPO MAP ⇒ tự phá prefix."* Phản chứng:
   `SKIP_DIRS` đã có `.scoder` (đo: map không chứa dòng `.scoder` nào). Prefix
   vẫn đổi, nhưng là vì **file thật của repo** thay đổi kích thước/số lượng.

Số liệu thô: `/private/var/folders/bl/8cp9kd_s0yx6q541cqdz3tpm0000gn/T/opencode/`
— `prompt-capture/` (MCP tắt, 2 agent), `bc7/` (MCP bật, 2 agent), `bc15/`
(chứng minh thêm 1 file đổi promptHash), `bc20/` (ma trận 5 task × block),
`anatomy-all.json`, `final-table.json`.

### 13.8 "Chat tiếp cửa sổ cũ lâu, mở cửa sổ mới nhanh" — tái hiện + kết luận

Hiện tượng user báo trên scoder TUI. Tái hiện đúng hình dạng của nó
(`twoturns.mjs`, chạy sau khi server đã restart `--parallel 1 --ctx-size 84000`,
MCP bật, reasoning on, qua capture proxy):

| Bối cảnh | prompt | cached | TTFT | tổng |
|---|---|---|---|---|
| A — "chào", request đầu sau restart (cache trống) | 14.488 | 0 (0%) | **30,1 s** | 44,9 s |
| A — **chat tiếp** "cảm ơn…" (cùng tiến trình, history +36 tok) | 14.524 | 14.484 (**99,7%**) | **0,54 s** | 3,8 s |
| B — **cửa sổ mới**, "chào" (tiến trình mới, cùng prefix) | 14.488 | 14.484 (**99,7%**) | **0,13 s** | 2,2 s |

Hai kết luận đo được, không suy đoán:

1. *Cửa sổ mới nhanh* **đúng là do cache**: request đầu của một phiên chỉ
   khác request trước ở đúng phần history (vài chục token), còn prefix cố
   định 14,5k (system prompt + 37 tool schema) được reuse gần như toàn bộ.
2. *Chat tiếp cửa sổ cũ* **không vốn chậm** — trên server hiện tại nó chỉ
   mất 0,54 s TTFT. Hiện tượng user thấy thuộc cấu hình cũ
   (`n_ctx 16.128`/slot × 2 slot): prompt lượt tiếp = 14,5k fixed + history
   + output (reasoning on → dài) **tràn slot 16k** ⇒ llama.cpp vứt KV của
   slot ⇒ prefill lại ~15–20k token ≈ 30–45 s; đồng thời không gửi
   `slot_id` ⇒ lượt tiếp có thể rơi sang slot lạnh (đo ở §13.5: 2/6 cold).
   Cửa sổ mới thì request vừa khít 14,5k nằm trong slot và ăn nhờ prefix
   mà cửa sổ cũ vừa warm — nên paradox "càng dùng lâu càng chậm, mở mới
   lại nhanh" biến mất ngay khi restart single-slot.

Việc còn lại: nếu user vẫn thấy chậm trên TUI thật với server mới, bước
tiếp theo là cắm capture proxy vào đúng tiến trình TUI để xem request nào
mất cache;P0-9 (pin `slot_id`) chỉ cần khi chạy `--parallel ≥ 2`.

### 13.9 "CỬA SỔ MỚI chat cũng chậm" — thủ phạm thật: REPO MAP phá prefix

Đo trên server IQ2_M (`--parallel 1`, ctx 84k) và IQ3_S (96k), replay đúng
request chào đã capture:

| Kịch bản | prompt | cached | TTFT |
|---|---|---|---|
| Lặp lại y hệt prefix đang warm | 14.488 | 14.484 (100%) | **0,09–0,10 s** |
| **Đổi đúng 1 ký tự** trong REPO MAP ("48KB"→"50KB") | 14.489 | **0** | **47,4 s** |
| Restart server (KV xóa sạch) rồi chat cửa sổ mới | 14.5k | 0 | 33–48 s |
| Cùng cửa sổ, lượt 2+ (prefix đóng băng trong RAM client) | 14.5k+hist | ~99,7% | 0,5 s |

Cơ chế: `buildRunMessages()` nhúng REPO MAP (có **dung lượng file**) vào
system prompt ⇒ **mỗi lần repo đổi file là prefix đổi byte ⇒ mọi cửa sổ mới
bị mất cache toàn bộ, trả 33–48s cold prefill cho tin nhắn đầu**. Đây đúng
là "chat chào ở cửa sổ mới cũng chậm". Kèm hai thủ phạm nhỏ:

- Restart server = xóa KV cache ⇒ cửa sổ kế tiếp chắc chắn cold.
- Mỗi lượt chat vẫn tốn **2 call** (call 2 text-only = guardrail, §13.2) —
  call 2 thường warm nhưng vẫn +2–3 s decode.
- IQ3_S **chậm hơn** IQ2_M khi cold: 47,5 s vs 33 s (decode ~22–25 tok/s như
  nhau). Đổi quant "cho nhanh" là ngược.

**Fix P0-10 — prefix nội dung ổn định (cross-session):**
(a) REPO MAP bỏ khỏi system prompt, đưa vào message cuối trước task (hoặc
block sau history) ⇒ prefix system+tools byte-stable giữa mọi cửa sổ ⇒
cửa sổ mới chỉ prefill phần map (~2,5k ≈ 8 s) thay vì 14,5k ≈ 47 s;
(b) bỏ dung lượng ` (48KB)` khỏi dòng map, đổi thành đường ống danh sách
file ổn định hơn; (c) hoàn thành P0-8 (1 call/chat).
KPI mới: TTFT tin nhắn ĐẦU của cửa sổ thứ 2 ≤ 10 s khi repo vừa đổi.

**ĐÃ TRIỂN KHAI (commit `d2812f4` + P0-8 bên dưới) — đo lại bằng đúng harness
3 process mới (server IQ2_M đang chạy, không restart giữa chừng):**

| Window | Bối cảnh | cached | TTFT | KPI |
|---|---|---|---|---|
| N1 | process mới, cold KV | 0 | 30,3 s | — (cold là cold) |
| N2 | process mới, **repo không đổi** | **14.209/14.213 (100%)** | **0,21 s** | ✓ (trước: 30,2 s) |
| N3 | process mới, **thêm 1 file** | **11.904 (84%)** | **8,9 s** | ✓ ≤10 s (trước: 30,2 s) |

Sửa map thành phần TUỐI (đứng sau prefix system+tools). Map mới còn bỏ
`N files` + `(48KB)` ⇒ sửa nội dung file không đổi symbol thì map giữ
nguyên byte ⇒ N2-like hit 100% ngay cả khi đang code. Call 2 trong cùng
process warm như cũ (530 ms).

## 14. TUI lag khi transcript dài — đo được, đã định vị, fix rõ

Triệu chứng user báo: mở TUI đã thấy lag; càng nhiều text càng lag.

Đo bằng fake-TTY mount đúng `ChatItemView` + viewport của `app.tsx`, bơm
delta 20 fps (như queue thật), so **CPU mỗi commit** theo số item mount:

| Items mounted | CPU/frame | Event loop | Ink writes/20 frame |
|---|---|---|---|
| 30 | 6,5 ms | khỏe | 4 |
| 60 | 10,3 ms | khỏe | 4 |
| 150 | 13,9 ms | ổn | 4 |
| 302 | **42–44 ms** | **0 ms idle — bão hòa** | 0–4 |
| 400 (cap reducer) | 53,5 ms | bão hòa, keystroke xếp hàng | 4 |

- Chi phí nằm ở **số item CÓ MẶT trong tree**, không phụ thuộc item đổi:
  `state.items.map(...)` mount toàn bộ transcript full-height để tính scroll
  ⇒ mỗi commit là một lần React diff + Yoga layout + wrap string-width qua
  CẢ transcript. memo() chỉ chặn render component, không chặn layout.
- 50 ms FLUSH × 44 ms CPU = 88% loop chỉ để vẽ ⇒ gõ phím chờ sau commit ⇒
  "càng nhiều text càng lag". Lúc idle chat ngắn: echo đo thật 22–31 ms
  (8–1KB ANSI/key) — TUI không lag từ số không; cảm giác lag chủ yếu khi
  transcript dài + khi đang stream.
- Engine prefill 47 s chạy song song **không** làm TUI lag thêm (echo vẫn
  24–40 ms) — tách rõ hai vấn đề.

**Fix P1-8 — virtualize transcript (helpers đã có sẵn, chưa nối):**
nối `visibleWindow()`/`estimateItemRows()` (src/tui/selectors.ts — tồn tại
nhưng chat không dùng) vào `app.tsx`: chỉ mount các item phủ [scrollTop,
scrollTop+viewportRows+margin]; offset scroll = tổng rows ước lượng của item
ẩn (không cần đo content.height thật nữa). KPI: CPU/frame ≤ 15 ms với
transcript 400 item (đo lại bằng chính harness này), echo ≤ 30 ms.

**ĐÃ TRIỂN KHAI (commit `019ff06`) — đo lại bằng frame4 (cùng harness, mount
qua `transcriptWindow` thật):**

| Items | CPU/frame trước | CPU/frame sau | mount |
|---|---|---|---|
| 52 | ~14–19 ms | **9,9 ms** | 14–17 |
| 302 | 42–44 ms (loop bão hòa) | **9,4–9,7 ms** | 14–17 |
| 400 (cap) | 53,5 ms | **9,0–9,5 ms** | 14–17 |

KPI ≤15 ms: ✓. Lưu ý implement: follow-bottom dùng chiều cao THẬT của cửa
sổ đã mount (đo rẻ vì cửa sổ nhỏ) — ước lượng có sai cũng không clip dòng
mới; khi scroll lên dùng offset ước lượng. Estimate của `notice`/`user`/
`build` phải tính theo dòng thật — bản đầu under-estimate làm clip dòng
sau `/help`, bắt được bởi PTY E2E (`tui.test.mjs`), đã sửa + test đơn vị.

**ĐÃ TRIỂN KHAI P0-8** (cùng commit docs này): bước text-only, không tool
call, `filesModified=false`, plan không mở ⇒ finish ngay `chatOnly` thay vì
inject nudge. Đo engine thật: "chào" = **1 call duy nhất** (in=14.213
out=26, "Done in 1 step(s)") — trước: 2 call (in=14.488 + in=14.569).
Nhánh an toàn giữ nguyên: plan đang mở → nudge như cũ; có sửa file → nudge
ép build (bảo vệ `aec95ef`); marker `<<CHAT_DONE>>` vẫn finish như cũ.
