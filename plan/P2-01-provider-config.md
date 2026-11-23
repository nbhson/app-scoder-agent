# P2.1 — Provider & Model config mở rộng (kiểu opencode)

> Trạng thái: CHƯA LÀM · Phụ thuộc: không · Liên quan: P2.2 (model router dùng danh sách model từ plan này)

## Mục tiêu

Bỏ việc model bị "config cứng" (5 built-in providers + model mặc định duy nhất), thay bằng khối
`provider` khai báo tự do trong `.scoderrc.json` theo đúng format opencode:

```json
{
  "provider": {
    "box-api": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Box API",
      "options": {
        "baseURL": "https://api.ai-box.vn/v1",
        "apiKey": "{env:BOX_API_KEY}"
      },
      "models": {
        "kimi-k3":        { "name": "kimi-k3" },
        "kimi-k2.7-code": { "name": "kimi-k2.7-code" },
        "glm-5.3":        { "name": "glm-5.3" },
        "qwen3.8-flash":  { "name": "qwen3.8-flash", "limit": { "context": 262144 } }
      }
    }
  }
}
```

Sau khi khai báo:

1. Dùng được `"model": "box-api/kimi-k3"` — resolve đúng baseURL + key + runtime.
2. `/model box-api/glm-5.3` hot-swap hoạt động với provider custom.
3. `scoder models` liệt kê provider × model từ config (gộp catalog models.dev).
4. contextWindow / pricing của model custom được sidebar ctx %, compaction, `scoder cost` dùng đúng.
5. Tương thích ngược 100%: format cũ `providers.<id>`, `baseUrl`, `model` một cấp vẫn chạy.

## Hiện trạng (code đã có)

| Vị trí | Trạng thái hôm nay | Vấn đề |
|---|---|---|
| `src/llm/provider-registry.ts:38` | `BUILTIN_PROVIDERS` cứng 5 id (openai, anthropic, openai-compatible, ollama, gemini) | không thêm provider mới ngoài rc |
| `src/llm/provider-registry.ts:104` `parseCustomProviders` | rc `providers.<id> = {baseUrl, apiKeyEnv, kind, supportCache, supportReasoning}` | **không có `models`**, không có display name, key chỉ qua env var |
| `src/config/config.ts:531-558` | chuỗi resolve model: flag > `SCODER_MODEL` > `OPENAI_MODEL` > rc `model`; key: flag > env > rc `apiKey` | không tra model name thuộc provider nào |
| `src/llm/model-catalog.ts:168` `lookupModel` | contextWindow/pricing từ cache models.dev + fallback snapshot | model custom (kimi-k3, glm-5.3 của box-api) → fallback 128k + giá "unknown" |
| `rc.provider` | **đang là string** (`"openai" | "anthropic"`) — config.ts:171 | xung đột tên với khối `provider` kiểu opencode → phải discriminating theo shape |
| `src/commands/registry.ts:216` `/model` | in model hiện tại; `/model <p/m>` swap | không liệt kê model khả dụng |

## Thiết kế

### 1. Schema chuẩn hoá — mở rộng `ProviderDef`

```ts
// src/llm/provider-registry.ts
export interface ModelConfig {
  /** Display name cho UI (`name` opencode); mặc định = id. */
  name?: string;
  contextWindow?: number;   // opencode: limit.context
  maxTokens?: number;       // opencode: limit.output
  pricing?: { input: number; output: number }; // opencode: cost.{input,output} (USD/1M tok)
  supportCache?: boolean;
  supportReasoning?: boolean;
  toolCall?: boolean;       // false → model không được router/tool-loop chọn
}

export interface ProviderDef {
  id: string;
  baseUrl: string;
  apiKeyEnv: string;
  kind: "openai" | "anthropic";
  displayName?: string;                      // rc "name"
  /** Inline key từ rc options — độ ưu tiên thấp hơn env/flag, xem §3. */
  apiKeyInline?: string;
  models?: Record<string, ModelConfig>;      // id → config; rỗng = không khai báo
  headers?: Record<string, string>;          // đã có, giữ
  supportCache?: boolean;
  supportReasoning?: boolean;
}
```

### 2. Parser mới `parseProviderConfig(raw)` — chấp nhận CẢ HAI hình thức

`loadConfig` gọi một hàm duy nhất merge 3 nguồn thành `Record<string, ProviderDef>`:

```
builtin (5 id)  <  rc.providers (format cũ)  <  rc.provider (format mới, opencode)
```

Quyết discriminating theo **shape**, vì `rc.provider` hiện là string:

| `rc.provider` là | Xử lý |
|---|---|
| string (`"openai"`, `"anthropic"`) | legacy — chọn provider active (code cũ, config.ts:516) |
| object (`{ "box-api": {...} }`) | NEW — parse từng id theo schema opencode |

Mapping fields opencode → runtime:

| rc | ProviderDef | Ghi chú |
|---|---|---|
| `npm` | `kind` | map theo bảng dưới; repo **0 runtime deps → không `import()` plugin npm**. `npm` chỉ là hint; chưa map được → `openai` + warn một lần |
| `name` | `displayName` | |
| `options.baseURL` | `baseUrl` | |
| `options.apiKey` | `apiKeyInline` | hỗ trợ `{env:VAR}` (dùng lại expand của `src/mcp/env.ts`) |
| `models.<id>.name` | `models[id].name` | |
| `models.<id>.limit.context / .output` | `contextWindow / maxTokens` | |
| `models.<id>.cost.input / .output` | `pricing` | |
| `models.<id>.reasoning / .tool_call` | `supportReasoning / toolCall` | |
| `options.headers` | `headers` | |

`npm → kind` map:

```
@ai-sdk/openai-compatible, @ai-sdk/openai, openai  → "openai"
@ai-sdk/anthropic, anthropic                       → "anthropic"
khác / thiếu                                        → "openai" + warn `ignoring unknown npm "<x>" for provider "<id>" — using openai-compatible runtime`
```

Validation kiểu `parseCustomProviders` hiện tại: entry sai → **bỏ qua + console.error cảnh báo**, không crash; id chứa `/` bị loại (tránh phân tách provider/model hỏng).

### 3. Thứ tự giải quyết API key (chuỗi mới)

```
--api-key flag  >  SCODER_API_KEY env  >  <provider.apiKeyEnv> env  >  provider.options.apiKey (rc)  >  rc.apiKey  >  ""
```

- `apiKeySource` (P0-5) thêm giá trị `"provider-rc"` — hot-swap **không** mang key của provider cũ sang provider mới (đúng bug class đã sửa ở `provider-runtime.ts`, phải giữ semantics).
- Security (nối P0-2 secrets):
  - Key inline trong rc → in cảnh báo commit-risk như cảnh báo `rc.apiKey` hiện tại (config.ts:634), nhắc dạng `{env:BOX_API_KEY}`.
  - Mọi log/TUI/JSONL đi qua redactor `sk-*` đã có — không dump key vào `scoder models`.

### 4. Resolve model → provider

Hàm mới trong provider-registry:

```ts
export function findModelOwner(
  id: string,                          // "kimi-k3"
  providers: Record<string, ProviderDef>,
): { provider: string; model: ModelConfig } | null
```

Chuỗi resolve trong `loadConfig` (thay đoạn 531–558):

1. `"box-api/kimi-k3"` → tách theo slash (giữ `splitProviderModel`), provider win.
2. `"kimi-k3"` (bare) + `rc.model` → tra `findModelOwner` trong **models khai báo ở rc**:
   - duy nhất 1 provider sở hữu → provider + baseUrl + key tự chọn theo;
   - nhiều provider cùng có → dùng provider của `rc.provider` string legacy / active provider, warn gợi ý viết `provider/model`;
   - không ai có → hành vi cũ (builtin + env), warn khi `model` không tồn tại trong catalog.
3. Model id chứa dấu chấm (`kimi-k2.7-code`) — chỉ split ở **slash đầu tiên**, không có gì phải đổi ở `splitProviderModel` (đã indexOf "/"), thêm unit test khoá hành vi.

### 5. Tích hợp model-catalog & cost (điểm ăn tiền cho UI)

- `src/llm/model-catalog.ts`: `lookupModel(provider, id)` tra **config-level trước** (models từ `parseProviderConfig`, lưu vào module-level `registerConfigModels(models)` khi `loadConfig` chạy), rồi cache models.dev, rồi fallback. → sidebar `ctx 84k/262k`, compaction trigger, `contextWindowFor` (agent.ts:19) đúng cho box-api.
- `src/shared/constants.ts resolveModelPricing`: thứ tự override mới `rc.modelPricing` > provider `models.<id>.cost` > catalog > unknown — session cost estimate (`src/session/cost.ts`) đúng với model custom.
- `AgentConfig.contextWindow` (config.ts:576) đã đọc `providerDef.contextWindow` — nối thêm: khi model được chọn có `models[id].contextWindow` thì value đó thắng.

### 6. UX

| Lệnh | Sau plan này |
|---|---|
| `/model` (không arg) | `model: kimi-k3 (Box API) · ctx 200k · provider: box-api` + nhắc `/model [provider/model] · xem: scoder models` |
| `/model box-api/glm-5.3` | hot-swap qua `agent.setModel` (đã có) — thêm validate: id không có trong `providerDef.models` (khi models được khai báo) → warn nhưng vẫn cho swap (escape hatch) |
| `/model auto` | (P2.2 §4c) bật router; P2.1 không tự xử lý — parser `/model` chỉ accept `auto` khi rc `router.tiers` hợp lệ |
| `scoder models` (mới, `src/commands`/cli) | bảng: `PROVIDER · MODEL · CTX · $IN/$OUT · SOURCE (config/catalog/builtin)`; cờ `--refresh` re-fetch models.dev |
| Palette TUI | action `models: list configured providers & models` mở output trong pager |

### 7. `resolvePrimaryConfig` / routing (nối P2.2)

`src/agent/types.ts:164-181` hiện tự re-resolve provider cho `"p/m"`. Refactor nhỏ: gọi hàm dùng chung
`resolveModelRef(ref, customProviders): { def, model } | { error }` — một đường resolve duy nhất cho startup, `/model`, routing và router (P2.2) — tránh 3 bản sao lệch nhau.

## File changes

| File | Thay đổi |
|---|---|
| `src/llm/provider-registry.ts` | `ModelConfig`, `ProviderDef` mở rộng; `parseProviderConfig` (shape-discrimination, npm→kind map, `{env:}`); `findModelOwner`; `resolveModelRef` dùng chung |
| `src/config/config.ts` | RcFile: `provider?: string | Record<string, unknown>`; chuỗi resolve model + key §3–4; `apiKeySource += "provider-rc"`; gọi `registerConfigModels` |
| `src/agent/provider-runtime.ts` | `resolveSwapConnection` tôn trọng `apiKeyInline` + source mới; build client mang `headers` của def |
| `src/agent/types.ts` | routing ref đi qua `resolveModelRef` |
| `src/llm/model-catalog.ts` | config-level lookup trước cache; `registerConfigModels` |
| `src/shared/constants.ts` | `resolveModelPricing` thêm tầng provider-model cost |
| `src/commands/registry.ts`, `definitions.ts` | `/model` list + hint; đăng ký `scoder models` |
| `src/cli/main.ts` (hoặc `commands` dispatch) | subcommand `scoder models [--refresh]` |
| `.scoderrc.example.json` | thêm khối `provider` mẫu (key dạng `{env:BOX_API_KEY}`) |
| `docs/`, `README.md` | mục "Custom providers & models" |

## Implementation plan

| Phase | Nội dung | Est. |
|---|---|---|
| P1 | Types + `parseProviderConfig` + `findModelOwner` + unit tests (chưa đụng resolve) | 0.5 ngày |
| P2 | Nối `loadConfig` (model→provider, key chain, apiKeySource) + compat test format cũ | 0.5 ngày |
| P3 | model-catalog `registerConfigModels` + pricing + ctx%/compaction/cost đúng model custom | 0.5 ngày |
| P4 | `/model` list, `scoder models`, palette, example rc | 0.5 ngày |
| P5 | Docs + chạy `npm run eval` baseline (model đổi chỗ không đổi hành vi loop) | 0.5 ngày |

## Tests (new/updated, `node --test`)

- `provider-config.test.mjs` (mới): parse full schema; `rc.provider` string vs object discrimination; npm→kind map; entry hỏng → warn + skip, không throw; `{env:VAR}` expand; id chứa `.` và dấu cách bị loại.
- `config.test.mjs` (cập nhật): `"model": "box-api/kimi-k3"` resolve baseUrl+key; bare `"kimi-k3"` tự owner; ambiguity warn; key chain §3 thứ tự đúng; `apiKeySource === "provider-rc"` không leak sang provider khác khi swap; format `providers` cũ y nguyên.
- `model-catalog.test.mjs`: config model thắng cache/fallback; contextWindow 262k lấy từ rc.
- `cost.test.mjs`: pricing từ `models.<id>.cost` dùng được, `modelPricing` rc vẫn thắng.
- `command-registry.test.mjs`: `scoder models` output đủ cột, redact key.

## Acceptance criteria

- [ ] Khối `provider` trong ví dụ §0 (thay key bằng `{env:BOX_API_KEY}`) chạy end-to-end: `scoder -m box-api/kimi-k3 "task"` gọi đúng `https://api.ai-box.vn/v1`.
- [ ] `"model": "qwen3.8-flash"` (bare) tự route vào box-api; sidebar hiện `ctx x/262k` theo rc khai báo.
- [ ] `scoder models` liệt kê đầy đủ 4 model box-api + builtin; không dòng nào chứa key thô.
- [ ] Toàn bộ test cũ (config/provider/anthropic/cost) pass không sửa assertion ngoại các case cố tình đổi chuỗi ưu tiên key.
- [ ] `/model openai/gpt-4o-mini` rồi `/model box-api/kimi-k3` — mỗi swap dùng **key của chính provider** (regression test P0-5).

## Risks

| Risk | Mitigation |
|---|---|
| Xung đột `rc.provider` string ↔ object làm hỏng user cũ | discrimination theo `typeof` + test tương thích; docs ghi rõ |
| Key inline bị commit | `{env:}` là dạng khuyến nghị; warning hiện có mở rộng quét cả `provider.*.options.apiKey` |
| models.dev cache ghi đè metadata model custom | thứ tự tra: config **luôn thắng** catalog (chỉ dùng khi rc không khai báo) |
| `npm` field gợi hiểu nhầm là plugin loading | warn khi unknown + docs nói rõ: runtime map, không cài package |

> **Note:** API key thật của box-api đã bị chia sẻ dạng plaintext trong chat — cần rotate trên box-api trước khi dùng; trong rc chỉ khai báo qua `{env:BOX_API_KEY}`, không commit key literal.
