# P2.2 — Model Router trung gian + tab ROUTER (track/audit)

> Trạng thái: CHƯA LÀM · Phụ thuộc: **P2.1** (danh sách provider×model từ config là nguồn tier) · Liên quan: `plan/performance-issue.md` (local profile), WARMUP (giữ ấm engine local)

## Mục tiêu

1. Thêm **1 lớp router** giữa agent loop và providers: mỗi lượt LLM được classify
   (nhỏ vs lớn) rồi navigate sang model phù hợp trong số các model đã config —
   việc nhỏ (đọc/liệt kê/search, trả lời ngắn) → model nhỏ/cheap; việc lớn
   (write/edit, build fail, review, plan) → model mạnh.
2. **Tab thứ 3 trên sidebar** (`OVERVIEW │ ROUTER │ LOG`) track/audit realtime:

```
user ──▶ router ──┬──▶ kimi-k2.7-code   (small)   ●──●──▶  đang chạy
                  ├──▶ qwen3.8-flash    (small)   3 calls · 1.2k tok
                  └──▶ kimi-k3          (large)   1 call  · escalation: build fail ×2
```

   + animation: "packet" chạy trên line tới model đang được chọn, model active
   highlight accent; bên dưới là audit list các quyết định route (click-up j/k như
   tab LOG) + counter per-model (calls / tokens / est. cost).

## Hiện trạng

| Vị trí | Có gì | Còn thiếu |
|---|---|---|
| `src/llm/provider-registry.ts:60` `ProviderRuntimeContract` | interface runtime **chính thức** mà Agent/tool code chỉ được dùng (I1 — mọi cast đã xoá) | đây chính là seam cắm router: 1 implementation nữa = `RouterRuntime` |
| `src/agent/types.ts:164` | routing tĩnh per-agent: `rc.routing = {plan, build, review} → "provider/model"` | không classify theo **nội dung từng lượt** |
| `src/agent.ts:1710 setModel` + `createSwappedRuntime` | swap cả client khi đổi provider | router cần **nhiều client cùng sống** (cache per model) |
| Sidebar: `sidebar.tsx:355` `tab?: "overview" | "log"`, `app.tsx:127 useState<…>`, `use-keybinds.ts:35` Ctrl+B toggle 2 chiều | tab-bar 2 tab, greedy-fit chiều cao | tab thứ 3 + cycle 3 chiều |
| `src/tui/state.ts` reducer + `log.ts` `LogCat` (run/llm/tool/…/evt) | ring buffer audit, filter, detail panel | cat `route` + model-stats |
| `src/tui/markdown/graph.ts` | layout engine flowchart thật (mermaid → cell grid, có `CellKind` để Ink tô màu riêng cho edge/box/label) | router không cần parse mermaid — build `FlowGraph` trực tiếp |
| `chat-views.tsx:29` Spinner | pattern animation đúng: component **tự giữ timer 80ms riêng**, không re-render cả app | packet animation theo pattern này |
| `src/session/cost.ts` | event `llm_usage` đã gắn `model`/`provider` trong JSONL | thiếu event *tại sao* chọn model đó |

## Thiết kế

### 1. `RouterRuntime implements ProviderRuntimeContract` (module mới `src/router/`)

```ts
// src/router/router-runtime.ts
export class RouterRuntime implements ProviderRuntimeContract {
  constructor(opts: {
    tiers: TierRuntime[];            // [{ ref: "box-api/kimi-k2.7-code", def, client }]
    fallback: TierRuntime;           // model mặc định khi router do dự / lỗi
    classify: Classifier;            // L1 score (§2) + L2 rules (§5)
    judge?: Judge;                   // L4 (§3) — undefined khi `router.judge: null` (pipeline 3 lớp)
    onRoute: (d: RouteDecision) => void;
  });
  chat(messages, tools, opts)   { const t = this.pick(messages, tools); return t.client.chat(...); }
  async *streamChat(...)        { const t = this.pick(...); yield* t.client.streamChat(...); }
  setModel(ref: string) { /* §4c: "/model <ref>" → PIN (router đứng chờ); "/model auto" → trả quyền cho router */ }
}
```

- `pick()` chạy **mỗi lượt LLM** (trước chat/streamChat), emit `RouteDecision`:
  `{ step, tier: "small"|"large", ref, reason, signals, changed }`.
- Client per model tạo lười (lazy) + cache `Map<ref, runtime>` qua `createRuntime(def, …)`
  (provider-registry.ts:90) — P2.1 cho sẵn def+key+baseUrl per provider.
- Wiring: `createClientRuntime` (agent/provider-runtime.ts:36) — khi `config.router?.enabled`
  trả `RouterRuntime`, còn lại nguyên đường cũ. `clientFactory` (eval I-12) **short-circuit trước
  router** → eval không đổi.
- Subagents: mặc định **kế thừa router** (cùng tiers); def có `model:` tường minh (frontmatter)
  thì pin model đó, bỏ qua router — tôn trọng config người dùng như routing v2.

### 2. L1 — Classifier heuristic thuần (0 chi phí, luôn chạy)

Signals tính từ chính messages/tools đang gửi (không request phụ):

| Signal | Nguồn | Thiên về tier |
|---|---|---|
| `estTokens` = tổng chars/4 của history | messages | < `smallMaxCtxTokens` (default 16k) → small |
| Phase run hiện tại | `state.phases` / agent.ts phase emit | explore/plan-init → small; edit/build-fail/verify/self-review → large |
| Tool result lượt trước là **build fail / guardrail / diff lớn** | Reporter events nội bộ (tool-executor trả summary) | large |
| ToolSpec size (bật MCP tools) | `tools.length + schema chars` | large nếu > ngưỡng (model nhỏ hay sai tool args) |
| Step index | run-loop | step 1 (plan) + 2 step cuối (wrap-up/finish) → large |
| `finish`-like turn (không tool call, cần tổng kết) | messages cuối toàn tool results | large |

Rules có thể **override** heuristic trong rc (§5): `"when": "phase == edit"` → tier ép.
`toolCall: false` (P2.1) loại model khỏi tier nào nó không tham gia được.

### 3. L4 — Judge: model rẻ đánh giá công việc → chọn đúng model target (`router.judge`)

**Semantics (đúng yêu cầu config 2 nhánh):**

| `router.judge` | Pipeline đánh giá |
|---|---|
| `null` / thiếu (default) | **3 lớp** — L1 score + L2 rules + L3 outcome feedback. Không thêm BẤT KỲ request phụ nào. |
| `{ model, scope, … }` | **4 lớp** — thêm L4: một model giá rẻ đọc công việc và trả về **target model cụ thể**. L1–L3 vẫn là sàn; L4 chỉ thắng khi kết quả hợp lệ. |

Khác biệt với "classifier tier" cũ: L4 không trả `small|large` mà trả **ref chính xác** trong
danh sách ứng viên — nghĩa là khi MỘT tier có nhiều model (small = `gemma4:e4b` +
`qwen3.6:35b`), judge tie-break theo nội dung việc (codegen → qwen3.6, tóm tắt/log → gemma4).

**Request judge** (temperature 0, maxTokens ≤60, JSON mode, prompt ≤600 token):

```
input:  objective (user message đầu của task, cắt 300 ký tự)
      + step hiện tại (phase, tool trước đó, build lamp, guardrail count)
      + candidates: bảng từ tiers (P2.1) — ref · ctx window · $/1M tok · tags
output: { "tier": "small|large", "model": "<ref>", "confidence": 0.0–1.0, "reason": "≤120 ký tự" }
```

**Validation — chống hallucinate model (nguyên tắc: judge không bao giờ được làm hỏng run):**

| judge trả | xử lý |
|---|---|
| `model` nằm trong allowlist `tiers` (đã lọc `toolCall:false` cho lượt có tools) | ACCEPT — target = ref đó, `reason = "judge: <reason>"` |
| `model` lạ / sai cú pháp / không tồn tại tier | REJECT → fallback decision của L1+L2, audit ghi `judge-reject(hallucinated)` |
| `confidence < minConfidence` (default 0.6) | REJECT → fallback L1+L2 |
| quá `timeoutMs` (default 2000) hoặc HTTP lỗi | REJECT → fallback L1+L2 — decision luôn tồn tại đường về deterministic |
| `tier` ≠ tier của `model` | model thắng nếu ref hợp lệ (tier suy ra từ ref), audit ghi `judge-tier-mismatch` |

**`scope` — khi nào L4 được gọi (kiểm soát overhead):**

| giá trị | trigger | chi phí |
|---|---|---|
| `"gray"` (default) | score L1 rơi vào band gray (§4b) | ~10–20% lượt — overhead nhỏ nhất |
| `"first"` | step 1 + mỗi lượt L1/L3 đổi tier | rẻ nhất — judge quyết "chiến thuật" cả run |
| `"always"` | mọi lượt LLM call | chuẩn nhất nhưng +0.2–2s + cost MỖI step — warn nếu eval xấu |

- Cache: key = `hash(objective + step-summary + candidate-list)` TTL 10′ → doom-loop/repeat
  không tốn 2 lần judge; entry `confidence` thấp không được tái sử dụng khi band đổi.
- Chi phí tự thân: request judge tag `purpose: "judge"` trong `llm_usage` → KHÔNG tính vào
  modelStats của target model; tab ROUTER cộng riêng 1 dòng `judge: 3 calls · 1.1k tok ·
  ~$0.001 · avg 480ms` để trade-off nhìn thấy được, không phải đoán.
- Migration: key cũ `router.classifier: true` ≡ `judge: { model: <tier.small rẻ nhất>, scope:
  "gray" }` — config loader map tự động + warn gợi ý viết lại.

### 4. L3 — Hysteresis & escalation (outcome feedback, chống dao động)

```
small ──(build fail liên tiếp ≥2 | guardrail doom-loop | 2 tool-args-repair liên tiếp)──▶ large
large ──(ctx nhỏ dần + 3 bước không lỗi + không còn phase edit)──────────────────────▶ small
```

- `stickyMinSteps` (default 2): không đổi tier trước khi đủ N bước (mỗi lần đổi = mất cache prefix,
  có thể đổi luôn phong cách output).
- Build đang fail → ** khoá large** cho tới khi build pass.
- Prompt-cache affinity (anthropic): cùng model liền mạch mới ăn cache — router giữ ref cũ khi
  classify ra kết quả bằng tier cũ, chỉ đổi client khi tier thực sự lật.
- Local engine (`ollama/…`): tôn trọng warm-up/keep_alive của `performance-issue.md P2` —
  tier small là local thì **không** demote khỏi nó trong < keep_alive window (đỡ trả 35–56s cold).

### 4b. Vì sao chọn ĐÚNG — 3 lớp mặc định + lớp judge (L4) + calibration

Pipeline mỗi lượt (chỉ khi mode AUTO, §4c):

```
L1 heuristic score (§2, free)
 └─ L2 rc rules override (§5, free)
     └─ [L4 judge (§3)]  — nếu router.judge ≠ null VÀ scope thoả → target model tường minh
         └─ execute
L3 outcome feedback (§4) — SAU execution: escalate/demote sửa quyết định của L1/L2/L4
```

Số lớp tham gia đánh giá = đúng theo config người dùng:

- **`router.judge: null` → 3 lớp** (L1+L2+L3, tất định, 0 request phụ). Band gray của L1
  resolve bằng **sai số bất đối xứng**: gray → large — giao việc lớn cho model nhỏ đốt 5–10
  step fail-loop, đắt hơn nhiều vài cent ngược lại.
- **`router.judge: {…}` → 4 lớp**: L4 đọc công việc bằng model rẻ và chọn **chính xác ref
  target** (kể cả tie-break trong cùng tier); L1–L3 vẫn là sàn — judge timeout/hallucinate/
  low-confidence thì fallback về decision L1+L2, run không bao giờ chết hay treo vì judge.

**Calibration loop:** mỗi decision + outcome ghi JSONL → dataset tier×model×success×cost×latency
(judge decisions tách riêng để đo *judge có đáng tiền không*: so pass-rate/cost 3 vs 4 lớp trên
cùng eval set — nếu 4 lớp không thắng, tài liệu hoá scope tối ưu). Gate bật `enabled` = chạy
`test/run-eval.mjs` các config (100% large | 100% small | router-3-lớp | router-4-lớp); yêu
cầu: pass-rate router ≥ pass-rate large − 2 điểm **và** cost giảm ≥ X% (chọn X từ baseline,
ghi `plan/baseline/`). Weights/thresholds/judge.model tinh chỉnh theo dữ liệu đó.

**Guards:** (a) con người thắng router — mọi lựa chọn tường minh (rc/flag `model`,
`/model <ref>`, frontmatter `model:` của agent def, rc `routing` per-agent) là **PIN**
và router không bao giờ override khi đang pin, judge càng không (xem §4c); (b) hysteresis §4 —
cảm giác "chọn sai" chủ yếu đến từ DAO ĐỘNG, không từ classify; chống bằng sticky, không bằng
judge nặng hơn.

### 4c. Chế độ hoạt động: PINNED ↔ AUTO (semantics `/model auto`)

| thao tác | mode | hành vi mỗi lượt |
|---|---|---|
| rc/flag `"model": "box-api/kimi-k3"`, `/model <ref>`, def `model:`, rc `routing` | **PINNED** | đi đúng ref đó 100%; router idle (không emit decision) |
| `/model auto` hoặc rc `"model": "auto"` + tiers hợp lệ | **AUTO** | pipeline L1→L2(→L4 judge) per lượt, L3 sửa sai (§4b) |
| `/model <ref>` khi đang auto | quay về PINNED | — (toggle 2 chiều, không restart, không sửa rc) |
| `/model auto` khi `router.enabled:false` / tiers rỗng | từ chối + warn | `router not configured — add "router.tiers" or keep a pinned model` |

- Startup: mode mặc định = PINNED theo `config.model`; `router.enabled` chỉ **mở tính
  năng** auto, còn **bật nó** là hành động của user (`model:"auto"` / `/model auto`) —
  tránh "router tự ý đổi model" làm người dùng bất ngờ.
- Tier source khi user chỉ config model mà chưa khai `tiers`: (1) `router.tiers` tường
  minh (khuyến nghị); (2) fallback auto-derive theo `cost.output` từ P2.1 — rẻ nhất nửa
  dưới = small, đắt nhất = large, kèm warn; (3) không pricing & không tiers → auto tắt,
  warn + giữ pin.
- Persistence: mode là runtime state (session JSONL ghi `run_start.model` dạng
  `"auto"` hoặc ref; restore session thì trả lại mode đó), **không** tự ghi vào rc.
- UI: `/model` không arg in `mode: pinned box-api/kimi-k3` hoặc `mode: auto · hiện
  đang ⤳ small qwen3.8-flash (ctx 6.2k)`; sidebar SESSION model + StatusBar hiển thị
  `auto → <ref active>` khi AUTO (đổi theo decision mới nhất).

### 5. Schema rc

```json
"model": "auto",
"router": {
  "enabled": true,
  "fallback": "box-api/kimi-k3",
  "tiers": {
    "small": ["box-api/qwen3.8-flash", "box-api/kimi-k2.7-code", "ollama/gemma4:e4b"],
    "large": ["box-api/kimi-k3", "anthropic/claude-sonnet-4-5"]
  },
  "signals": { "smallMaxCtxTokens": 16000, "largeToolSchemaChars": 30000 },
  "rules": [
    { "when": "phase == verify", "use": "large" },
    { "when": "step == 1",       "use": "large" }
  ],
  "escalate": { "buildFails": 2, "stickyMinSteps": 2 },
  "judge": null
  // bật lớp 4 thì thay bằng:
  // "judge": {
  //   "model": "box-api/qwen3.8-flash",  // model rẻ đánh giá (default: tier.small rẻ nhất)
  //   "scope": "gray",                    // "gray" (default) | "first" | "always"
  //   "timeoutMs": 2000,
  //   "minConfidence": 0.6
  // }
}
```

- Mọi ref theo syntax P2.1 (`provider/model` hoặc bare nếu unique). Ref không resolve được →
  warn + loại khỏi tier; tier rỗng → router tự tắt (`router disabled — no valid tier models`).
- `enabled: false` (default toàn cục cho tới khi test đủ tin cậy) = hành vi y hệt hôm nay.
- Validation kiểu `parseLimits`: số âm/NaN bỏ qua, dùng default.

### 6. Event & persistence

```ts
// src/agent/types.ts — thêm vào union AgentEvent (schema version bump)
| { type: "route_decision"; step: number; tier: "small" | "large"; model: string;
    provider: string; reason: string; signals: Record<string, number | string>;
    switched: boolean;
    judge?: { model: string; confidence: number; ms: number; tokens: number;
              verdict: "accept" | "reject-hallucinated" | "reject-confidence" | "timeout" | "fallback" } }
```

- `session/logger.ts` ghi JSONL `type:"route"` → `scoder cost` mở rộng: **chi phí per-model**
  (đã có model trong `llm_usage`) + per-tier; `scoder cost --router` in bảng tiết kiệm
  est. so với chạy 100% fallback large.
- Chat transcript: 1 dòng `⤳ kimi-k2.7-code — ctx 6.2k · explore` (Reporter, chống spam: fold
  `×N` khi cùng ref liên tiếp — pattern `foldLog` state.ts:292).

### 7. TUI — tab thứ 3

**Tab plumbing** (type widen `"overview" | "log"` → `"overview" | "router" | "log"` tại 4 điểm:
sidebar.tsx:355/472, app.tsx:127/423, use-keybinds.ts:36, chrome.tsx StatusBar hint):

- Ctrl+B **cycle** 3 tab; giữ phím `v` (log→overview nhanh) nếu đã có; thêm palette actions
  `view: router`.
- TabBar: `OVERVIEW │ ROUTER │ LOG` — router hiện badge `R` khi đang active-run +
  `[small→large]` flash 1 nhịp khi có decision mới.

**RouterTab layout** ( Sidebar height budget greedy-fit như hiện tại — `rows` prop):

```
┌ ROUTER ────────────────────────────────┐
│ user ──▶ router ──┬─▶ qwen3.8-flash ●  │  graph ~6–10 dòng
│                   ├─▶ kimi-k2.7-code   │
│                   └─▶ kimi-k3 ◀active  │
│ ── DECISIONS ──────────────────────────│
│ 19:31:04 EVT L  ⤳ large  kimi-k3   bld │  audit list (ring buffer routes)
│ 19:30:58 EVT L  ⤳ small  qwen3.8   ctx │  j/k select · Enter detail
│ 19:30:41 EVT L  ⤳ small  qwen3.8   ctx │
│ ── MODELS ─────────────────────────────│
│ qwen3.8  12c 18k→4.2k tok  ~$0.02      │  per-model stats
│ kimi-k3   2c  9k→3.1k tok  ~$0.01      │
└────────────────────────────────────────┘
```

- **Graph**: build `FlowGraph` programmatic (nodes: user/router/1 node per model ref; edge label
  = tier), reuse renderer `graph.ts` (đã cho `CellKind` per cell → Ink màu riêng edge/box).
  Fallback khi pane hẹp/cao không đủ (`MAX_GRAPH_ROWS`): cây ASCII thuần 1 cột — không bao giờ
  clip nửa hình (đúng hợp đồng graph.ts).
- Node model active: `bold + accent` + `◀`; model chưa từng dùng: dim; model có pending stream:
  glyph `◐`.
- **Judge (khi L4 config)**: node `judge` con của `router` trong graph — edge user→router→judge→
  target sáng theo packet khi judge đang chạy (`scope` trigger); badge `J` confidence `0.8` ở
  dòng decision audit (`⤳j` phân biệt với `⤳` deterministic); reject/fallback tô warn color.
  Stats dòng `judge` tách riêng (§3) — không lẫn vào modelStats của target.
- **Animation packet**: component `RoutePacket` riêng (pattern spinner cô lập chat-views.tsx:29 —
  tự timer, không re-render app): dot `●` chạy dọc edge user→router→model active, chu kỳ
  ~600ms/edge; chỉ tick khi tab router đang mở **và** có stream đang chạy (idle = đứng yên ở
  model cuối; `prefers-no-motion`-style: env `SCODER_ANIM=0` tắt). ASCII mode (charset.ts) → dot
  là `*` và line `->`.
- **Audit list** dưới graph: dùng lại machinery `LogTab` (window + detail) với filter mặc định
  cat `route`; `LogCat += "route"` (label `ROUTE`, glyph `⤳`, bucket mới trong `LOG_FILTER_CYCLE`).
- **state.ts**: `routes: LogEntry[]` (ring, fold cùng ref), `activeRoute: { ref, phase } | null`,
  `modelStats: Record<ref, { calls, input, output, cached, costUsd }>` — fold từ `route_decision`
  + `llm_usage` (đã có model). Reducer test thuần (không render) như tui-state.

## File changes

| File | Thay đổi |
|---|---|
| `src/router/types.ts`, `classifier.ts`, `judge.ts`, `router-runtime.ts` (mới) | module router thuần, không Ink, không I/O — `judge.ts` tự own prompt/validate/cache |
| `src/agent/provider-runtime.ts` | `createClientRuntime` branch router; export factory `makeRuntimeForRef(ref, config)` dùng chung |
| `src/agent.ts` + `run-loop.ts` | emit `route_decision` từ onRoute; wiring phase → classifier |
| `src/agent/types.ts` | event mới + parse rc `router` validation (hoặc để config.ts parse như `parseLimits`) |
| `src/config/config.ts` | `router` RcFile + merge global/project + validate |
| `src/session/logger.ts`, `session/cost.ts`, `shared/constants.ts` | persist + cost per model/tier |
| `src/tui/state.ts`, `log.ts` | cat `route`, `routes`, `activeRoute`, `modelStats` |
| `src/tui/sidebar.tsx` | tab "router" + `RouterTab` + TabBar 3 tab |
| `src/tui/router-view.tsx` (mới) | graph + packet + list + stats |
| `src/tui/app.tsx`, `hooks/use-keybinds.ts`, `chrome.tsx` | widen tab union, cycle 3 chiều, hint `Ctrl+B router` |
| `src/tui/markdown/graph.ts` | export `layoutGraph(g, width)` cho caller ngoài mermaid (không đổi engine) |
| `src/commands/registry.ts` | `/model <ref>` = pin, `/model auto` = bật router (§4c), `/model` không arg in mode + active route; `/router` (status tiers/rules, `on|off` alias của auto) |
| `.scoderrc.example.json`, docs | khối `router` mẫu + mục "Model routing" |

## Implementation plan

| Phase | Nội dung | Est. |
|---|---|---|
| A | `src/router/` core: types, L1/L2 classifier, RouterRuntime + cache client, hysteresis — **test bằng fake clientFactory trước khi nối agent** | 1.5 ngày |
| B | rc `router` parse/validate + wiring `createClientRuntime` + event `route_decision` + JSONL/cost | 1 ngày |
| C | Tab router: widen union, RouterTab tĩnh (graph + audit + stats, chưa animate) | 1 ngày |
| D | Packet animation + active highlight + fold/spam-guard + ASCII/`SCODER_ANIM=0` | 0.5 ngày |
| E | L4 judge (`router.judge`: prompt, JSON validate + allowlist, scope/cache, purpose-tag) + `/router` command + docs + eval 4-config | 1 ngày |

Thứ tự có thể ship dần: A–B chạy đầu-cuối được với `enabled:false` default; C–D chỉ là hiển thị.

## Tests

- `router-mode.test.mjs` (§4c): pinned ⇒ 0 `route_decision` emit; `/model auto` ↔ `/model <ref>`
  toggle trong session; `auto` khi tiers rỗng ⇒ warn + giữ pin; startup `"model": "auto"` resolve
  đúng mode; auto-derive tiers theo `cost.output` khi thiếu `router.tiers`.
- `router-classify.test.mjs`: bảng signal→tier (mỗi signal 1 case + tổ hợp); rules override; `toolCall:false` bị loại; ref hỏng → tier rỗng → disabled-warn.
- `router-runtime.test.mjs`: dùng `clientFactory` style fake — assert chat() gọi đúng model per kịch bản history; emit decision đủ field; lazy client cache (2 lần same tier = 1 client); `setModel` toggle pin↔auto (§4c).
- `router-hysteresis.test.mjs`: build fail ×2 → large và **khoá** tới khi pass; stickyMinSteps chống flip; escalate-demote sau 3 bước sạch.
- `router-judge.test.mjs` (§3): `judge: null` ⇒ 0 request ngoài target (đếm qua fake factory); accept path — model hợp lệ trong allowlist thắng L1 kể cả khi khác tier; hallucinated ref / confidence thấp / timeout / JSON rác ⇒ fallback đúng decision L1+L2, verdict ghi đủ; `scope: gray|first|always` trigger đúng lượt; cache hit không gọi lại, entry low-confidence không dùng khi band đổi; `purpose:"judge"` tách khỏi modelStats; migration `classifier:true` → warn + map.
- `event-v2.test.mjs` (update): schema version + `route_decision` serialize/deserialize; JSONL round-trip.
- `cost.test.mjs`: per-model breakdown từ llm_usage; `--router` savings estimate.
- `tui-state.test.mjs`: fold decisions (ring, dedupe `×N`), modelStats cộng đúng.
- `tui-sidebar.test.mjs` / `tui-render.test.mjs`: tab 3 render ở 48 cols; snapshot graph; fallback ASCII khi `rows` nhỏ; packet đứng khi `SCODER_ANIM=0`.
- `hot-reload.test.mjs` (update): sửa `router.tiers` lúc run → decision lượt kế dùng tier mới.
- Eval guardrail: chạy `test/run-eval.mjs` 4 config (100% large | 100% small | router-3-lớp | router-4-lớp-judge) — pass-rate không giảm quá 2 điểm, so cost/latency 3 vs 4 lớp để chốt `scope` mặc định; ghi baseline vào `plan/baseline/`.

## Acceptance criteria

- [ ] Config P2.1 ví dụ (4 model box-api) + `ollama/gemma4:e4b`: bật `router.enabled` → run mẫu
    "liệt kê các file trong src/" toàn tuyến **small**; run "refactor config.ts tách trust.ts"
    sang **large** ở phase edit và khi build fail.
- [ ] Ctrl+B cycle OVERVIEW → ROUTER → LOG; tab ROUTER show graph user→router→models, packet
    chạy tới model active, audit list có reason từng decision, stats per-model cộng đúng với
    `scoder cost`.
- [ ] `/model box-api/kimi-k3` → MỌI lượt đi đúng ref đó (pinned, 0 `route_decision` emit);
    `/model auto` → router phân lớp per lượt; toggle 2 chiều ngay trong session, không restart.
- [ ] `router.judge: null` (default) ⇒ pipeline 3 lớp, fake-factory đếm **0 request phụ**; config judge ⇒
    decision gray-zone mang `verdict:"accept"` + target là ref chính xác judge trả (kể cả tie-break
    2 model cùng tier small). Judge timeout/hallucinate ⇒ run vẫn đi tiếp với decision L1+L2, audit
    hiện `⤳j fallback`, 0 exception mới.
- [ ] `route_decision` nằm trong session JSONL; `scoder cost` in được bảng chi phí per model.
- [ ] `router.enabled: false` (default) — mọi test cũ pass nguyên trạng, 0 byte overhead trong hot path.
- [ ] `typecheck`, `lint`, `check:layers` (module `src/router` sạch layer), coverage ≥ ngưỡng `coverage:check`.

## Tiến độ implementation

- **Phase A (xong):** `src/router/{types,classifier,hysteresis,router-runtime,tiers}.ts` — pipeline L1–L3 + Runtime seam (client cache, pin↔auto, external pin). 4 test files (`router-classify/runtime/hysteresis/mode`) = 56 case.
- **Phase B (xong):** rc `router` parse/validate (`parseRouter`) + startup `"model":"auto"` → `routerMode` (config.ts); `resolveRouterTiers` strict-ref + auto-derive theo `cost.output`; `createClientRuntime` branch RouterRuntime (clientFactory thắng trước — eval không đổi); Agent sensors nghe chính event stream (`TurnSensors`), `onRoute` → event `route_decision` (schema v3) + JSONL + attribution `ref/tier` vào `llm_usage`; `/router` + `/model auto`; `scoder cost --router` per-model/tier + savings estimate; hot-reload `router.tiers` qua `setTiers`. Test: `router-config.test.mjs` (23), `event-v2`/`cost` mở rộng.
- **Còn lại:** Phase C (tab ROUTER + Ctrl+B cycle + fold `route_decision` vào `state.ts`/`log.ts`), Phase D (animation RoutePacket), Phase E (`router/judge.ts` L4 + eval 4-config + baseline).
- **Green at HEAD:** `npm run build` clean, toàn suite `node --test test/*.test.mjs` pass, `lint` ≤ 43 warning, `typecheck`/`check:layers`/`docs:check`/`coverage:check` pass.

| Risk | Mitigation |
|---|---|
| Model nhỏ làm hỏng tool-loop (args sai, hallucinate path) | ngưỡng signal thiên về large khi tools lớn; escalate nhanh (§4); tool-args repair hiện có là lưới chắn cuối; default `enabled:false` tới qua eval |
| Mất prompt-cache prefix khi đổi model giữa phiên | hysteresis sticky + chỉ lật khi tier đổi thật sự; đo bằng `cached` metric sidebar |
| 2 endpoint × context format lệch (tool_calls khác nhau) | mọi model qua cùng surface `ProviderRuntimeContract`; anthropic-compat đã normalize ở client; message history portable |
| Ollama cold-load khi router demote về local | rule §4: không demote vào engine local trong keep_alive window (link WARMUP plan) |
| Tab 3 làm sidebar chật trên terminal 24 dòng | greedy-fit sẵn có: section DECISIONS co lại, graph degrade thành ASCII cây, không clip nửa |
| Chi phí ẩn layer judge | opt-in `router.judge` (null = mặc định 3 lớp, 0 request phụ); scope `gray` chỉ ~10–20% lượt; timeout 2s + cache TTL 10′; cost/latency của chính judge hiển thị tách riêng trên tab ROUTER + eval gate so 3-vs-4 lớp |
| Judge hallucinate model không tồn tại ⇒ fail request thật | allowlist validation `tiers` (tính cả `toolCall:false`), confidence floor, mọi reject ⇒ fallback deterministic L1+L2 — judge là *gợi ý có thẩm quyền*, không phải *nguồn duy nhất* |
| Judge + classifier bất đồng ⇒ khó giải thích quyết định | thứ tự thắng cố định công khai: pin > L2 rules > L4 judge (khi accept) > L1 score > L3 override sau-run; `reason` trong audit ghi rõ tầng nào quyết định |
