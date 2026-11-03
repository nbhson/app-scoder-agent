# Kế hoạch nâng cấp scoder chuẩn Enterprise (tham chiếu opencode)

> Version 1.0 — 01/11/2026. Base: `app-scoder-agent` v0.6.0 (~17.2k LOC, coverage 90.28% line / 81.59% branch).
> Tham chiếu: `sst/opencode` — `packages/core` (permission, skill, mcp, session/runner, tool), `packages/tui`, `packages/plugin`, `packages/theme`.

## Mục lục
1. [Đánh giá kiến trúc hiện tại](#1-đánh-giá-kiến-trúc-hiện-tại)
2. [Chiến lược nâng cấp 4 trụ cột](#2-chiến-lược-nâng-cấp-4-trụ-cột)
3. [Lộ trình thực hiện](#3-lộ-trình-thực-hiện)
4. [Kế hoạch kiểm thử & chất lượng](#4-kế-hoạch-kiểm-thử--chất-lượng)
5. [Rủi ro & giảm thiểu](#5-rủi-ro--giảm-thiểu)

---

## 1. Đánh giá kiến trúc hiện tại

### 1.1 Cấu trúc

```
CLI (index.ts 638) ──► Frontend: tui/app.tsx (Ink) | server.ts (SSE) | REPL inline
        └──────────► Agent (agent.ts 1329) — orchestrator + GuardrailEngine (guardrails.ts)
                     ├─ LLM: llm.ts (OpenAI-compat) | provider-anthropic.ts | provider-registry.ts
                     ├─ Tools: tools.ts (852) + webfetch/diff/build
                     ├─ Safety: permissions.ts (685) + shell-scanner.ts (tree-sitter)
                     ├─ State: session, snapshot, logger, cost, compaction, context
                     └─ Extension: mcp.ts, skills.ts, agents.ts, model-catalog.ts
```

### 1.2 Điểm mạnh

| # | Điểm mạnh | Bằng chứng |
|---|---|---|
| S1 | **Event contract sạch**: `AgentEvent` (agent.ts:59-99) là hợp đồng duy nhất core ↔ mọi frontend (TUI, SSE) — đúng pattern `bus` của opencode | agent.ts, server.ts |
| S2 | **Permission engine mạnh**: 50+ catastrophic deny regex (fuzz 200+ case), rule engine v2 last-match-wins + wildcard + policy hard floor, AST shell scanner tree-sitter, scanner-fail ⇒ ask | permissions.ts:16-66,128-140; test/catastrophic-fuzz.test.mjs |
| S3 | **Guardrail rule engine thuần function, có `register()`**, 10 rules cấu hình được, decision log | guardrails.ts:365 |
| S4 | **Provider registry** builtin + custom rc + auto-discovery ollama/lmstudio/vllm | provider-registry.ts:82-162 |
| S5 | **Secrets hygiene tốt**: redactSecrets 9 patterns (llm/MCP/compaction), `{env:VAR}` cho MCP, Bearer token server, pre-commit scanner | llm.ts:12-22, mcp.ts:100, scripts/check-secrets.mjs |
| S6 | **Test thâm hầu**: 34 test files, e2e closed-loop mock LLM, MCP mock server, TUI qua PTY thật, eval scripts (doom-loop, completion-claim, subagent…) | test/ |
| S7 | **Typing sạch**: 0 `as any`/`@ts-ignore`, strict mode | toàn repo |
| S8 | Session persistence atomic + snapshot/undo + compaction + cost tracking | session.ts, snapshot.ts, compaction.ts, cost.ts |

### 1.3 Điểm yếu

| # | Điểm yếu | Bằng chứng | Hệ quả |
|---|---|---|---|
| W1 | **agent.ts khổng lồ, 5 trách nhiệm trộn nhau**: run loop + steering + permission plumbing + MCP routing + skill staging + model hot-swap + subagent spawn; `runLoop()` ~270 dòng với ~8 biến tracker song song | agent.ts:862-1130, constructor 206-244 | GuardrailEngine tồn tại nhưng một nửa decision (streak, sigRepeat, lowTokenStreak) vẫn hard-code trong runLoop — duplication trách nhiệm, khó test |
| W2 | **tui/app.tsx 1412 dòng**: `submit()` ~340 dòng chứa 13 nhánh slash-command dispatch inline; state machine `/review` 200 dòng trong 1 file | app.tsx:631-968, 443-629 | Sửa 1 lệnh touch nhiều chỗ; không tái sử dụng được |
| W3 | **Slash commands duplicate 3 nơi**: REPL (index.ts:377-447), TUI (app.tsx:766-926), tui/commands.ts | ~200 dòng lặp | Drift logic, bug fix phải làm 2-3 lần |
| W4 | **`setTaskRunner` global mutable** — 2 Agent song song (server mode đa-run) thì subagent cha sai runner | tools.ts:803-843 | Break server mode concurrent |
| W5 | **Core import ngược vào TUI/UI**: agent.ts:8 import `tui/at-complete.js`; ui.ts (ANSI display) bị core import trực tiếp | agent.ts:8, ui.ts | Sai hướng dependency, không chạy headless thuần |
| W6 | **Không sandbox thực**: run_command spawn `/bin/sh -c` trực tiếp trên host; MCP tools chạy unsandboxed; env con kế thừa full `process.env` | tools.ts:464, agent.ts:469-493 | Rủi ro lớn nhất ở chuẩn enterprise |
| W7 | **Secret redaction chưa phủ run_command output**: stdout `echo $API_KEY` vào conversation + JSONL log nguyên vẹn | agent.ts:526 | Rò rỉ secret vào log/session |
| W8 | **~50 `catch {}` swallow không log**; `unhandledRejection` chỉ warn | tools.ts:253, mcp.ts:115, llm.ts:556, index.ts:19-22 | Mất traceability khi debug |
| W9 | **~57 cast `as {...}`** để chạm vào field runtime của client thay vì interface `ProviderRuntime` có sẵn | session.ts (11), agent.ts:11, vd agent.ts:1289 | Type-safety giả tạo |
| W10 | **MCP chỉ stdio**, không hot-reload, không reconnect, không validate inputSchema trước call; skills không hot-reload, thiếu metadata chuẩn | mcp.ts, skills.ts | Vận hành yếu |
| W11 | **Hardcoded thresholds** rải rác: timeout 120s/60s/30s, MAX_OUTPUT_CHARS 20k, concurrency 4, RENDER_CAP 200, MCP clamp 20k | nhiều file | Không tune được cho enterprise |
| W12 | **2 hệ permission song song**: legacy classifyCommand `startsWith` + rule engine v2 | permissions.ts:211,221 | Dễ nhầm, mâu thuẫn logic |
| W13 | TUI render cap 200 items — scroll quá mất nội dung cũ; modal permission text-only, diff cắt 12 dòng | app.tsx:1067-1069, 1142 | UX dưới chuẩn opencode |

### 1.4 Rủi ro chính

1. **R1 — Security**: không sandbox + W7 secret leak + MCP bypass permission (agent.ts:469-493). Nếu dùng trong môi trường enterprise có dữ liệu nhạy cảm → rò rỉ dữ liệu/secret, command ngoài phạm vi dự án.
2. **R2 — Correctness server mode**: W4 + thiếu isolation giữa các run → subagent/tool state cross-contamination.
3. **R3 — Maintainability của 2 file 1300+ dòng**: mỗi feature mới (đặc biệt command/permission) tăng chi phí tuyến tính vì W2/W3.

### 1.5 Extensibility hiện tại

| Mở rộng | Cách hiện tại | Đánh giá |
|---|---|---|
| Provider mới | registry + `kind: openai|anthropic`; kiểu mới phải sửa `createRuntime` if/else | Trung bình — cần plugin hook |
| Tool mới | sửa tools.ts 850 dòng | Trung bình — cần registry ngoài module |
| MCP server | config-only | Dễ |
| Skill | `.scoder/skills/*/SKILL.md` | Dễ |
| Guardrail rule | `register()` pure function | Dễ |
| Theme | theme.tsx | Dễ |

---

## 2. Chiến lược nâng cấp 4 trụ cột

### Trụ cột 1 — Harness: Guardrail Engine (đích: gần bằng opencode)

**Hiện trạng**: rule engine tốt (S3) nhưng decision logic tách đôi giữa runLoop (W1) và engine; không sandbox (W6); redaction hở run_command (W7); 2 hệ permission song song (W12).

| # | Thay đổi | Nguồn tham chiếu opencode | Cách tích hợp | Tiêu chí nghiệm thu |
|---|---|---|---|---|
| G1 | **Chuyển toàn bộ tracker state vào GuardrailEngine**: `textOnlyStreak`, `sigRepeat`, `toolErrorSig`, `lowTokenStreak` thành per-rule state; runLoop chỉ emit event, engine quyết | `packages/core/src/session/runner/step.ts` + `max-steps.ts` (runner tách khỏi policy) | Refactor `runLoop`: mỗi vòng `engine.observe(event)` → `engine.decide()`; xoá ~150 dòng tracker khỏi agent.ts | runLoop < 150 dòng; eval doom-loop + completion-claim vẫn pass |
| G2 | **Hợp nhất 2 hệ permission**: bỏ legacy `classifyCommand startsWith`, giữ rule engine v2 làm đường duy nhất; legacy lists thành builtin rules | `packages/core/src/permission.ts` + `v1/config/permission.ts` (một schema duy nhất) | Xoá classifyCommand; catastrophic list → rules `effect: deny` hard floor; rc chỉ 1 schema permission | catastrophic-fuzz.test 200+ case giữ nguyên kết quả; env-policy test pass |
| G3 | **Redact run_command output + env filtering khi spawn**: `redactSecrets` cho stdout/stderr trước khi vào conversation/log; spawn với env allowlist (`PATH, HOME, LANG, TMPDIR` + custom) | `environment/environment.ts` + `exec-defaults.ts` | Sửa `toolRunCommand`: `env: buildChildEnv(policy)`; redact trước `summariseOutput` | test mới: secret qua stdout/env ra `[REDACTED]` trong conversation + JSONL log |
| G4 | **Sandbox layer cho run_command** (ponytail: bắt đầu bằng detection, không hard-depend): có `sandbox-exec` (macOS) / `bwrap` / `docker` thì wrap lệnh theo profile `readonly|workspace-write`; không có thì chạy trực tiếp + warn | `environment/` drivers (local/memory/unavailable) | Module mới `src/sandbox.ts`: detect wrapper, build args, chặn fallback khi mode=readonly | sandbox.test: readonly mode không ghi được ngoài workspace; fallback warn khi thiếu binary |
| G5 | **MCP qua permission engine**: mọi `mcp__*` tool call đi qua `requestPermission` với rule resource `mcp/<server>/<tool>`; bỏ nhánh bypass | `packages/core/src/tool/mcp.ts` + permission apply cho MCP tools | agent.ts: route MCP call qua permission pipeline như tool thường | test: readonly mode chặn MCP call ghi; rule `mcp/**` deny hoạt động |
| G6 | **Guardrail async rule + budget rule**: cho phép rule async (verify-build), thêm rule cost/token budget per session | `session/runner/retry.ts` + max-steps pattern | Mở rộng `GuardrailRule` return `Promise`; thêm `budget.ts` rule đọc cost.ts | rule budget: vượt cap → pause + notice; guardrails.test mở rộng |
| G7 | **Gộp cấu hình thresholds** vào rc: `limits.{requestTimeoutMs, maxOutputChars, toolConcurrency, renderCap}`; bỏ hardcoded | `config/normalize.ts` | config.ts: parse + validate + defaults; các module đọc từ config | config.test: defaults + override; grep không còn magic number |

### Trụ cột 2 — Intelligence (đích: gần bằng opencode)

**Hiện trạng**: provider registry tốt (S4), streaming có (P0-03), compaction + context.ts có; nhưng provider kind if/else, không plugin, model catalog tĩnh.

| # | Thay đổi | Nguồn tham chiếu opencode | Cách tích hợp | Tiêu chí nghiệm thu |
|---|---|---|---|---|
| I1 | **ProviderRuntime interface chính thức**: thay ~57 cast `as {...}` bằng interface chung (`setModel`, `lastPartialToolCalls`, `streamChat`, `countTokens`) trong provider-registry.ts | `packages/ai` + `aisdk.ts` (chuẩn hoá runtime interface) | Khai báo `interface ProviderRuntime` đầy đủ; OpenAI + Anthropic runtime implement; xoá casts | typecheck pass; session.ts/agent.ts 0 cast runtime |
| I2 | **Tool registry tách module**: `src/tools/` — mỗi tool 1 file export `{name, spec, run(ctx, args)}`; `registry.ts` gom + cho phép đăng ký từ ngoài (plugin/MCP/subagent); ToolContext thay global `setTaskRunner` | `packages/core/src/tool/plugin/*.ts` (mỗi tool 1 file) + `tool/runtime.ts` | Di chuyển 9 tool từ tools.ts sang `src/tools/`; `ToolContext` chứa taskRunner, permissions, cwd; xoá mutable global | tools.test pass; server mode 2 run song song: subagent cha đúng runner (test mới) |
| I3 | **Prompt/system prompt builder tách module**: `src/prompt-builder.ts` — lắp system prompt từ: base + AGENTS.md + skills advertised + agents def + MCP instructions; hiện rải trong agent.ts/prompt.ts | `session/context.ts` + `skill/instructions.ts` | Gom logic lắp prompt vào 1 module thuần, test được độc lập | prompt-builder.test: snapshot prompt theo fixture; agent.ts bớt ~80 dòng |
| I4 | **Compaction nâng cấp**: hiện summary 1 lần; thêm trigger theo % context window từ model-catalog + giữ lại tool-call khung + summary có cấu trúc (goal/decisions/files) | `session/compaction.ts` (opencode) | compaction.ts: đọc contextWindow từ catalog; prompt summary template; giữ nguyên redactSecrets | eval dài (>100 turn): không mất goal; test compaction trigger theo % |
| I5 | **Steering + queue message chuẩn hoá**: steering inbox hiện trong runLoop; tách `steering.ts` với policy (giữa tool-call vs giữa step), retry/backoff chung `retry.ts` | `session/runner/llm.ts` + `retry.ts` | Steering inbox thành module; agent.ts gọi API; thêm test xoắn: steer trong lúc tool chạy | eval steering pass; test mới: steer giữa parallel tool calls không rơi message |
| I6 | **Model catalog động**: fetch models endpoint của provider (OpenAI `/v1/models`, Anthropic `/v1/models`), cache TTL 1h, fallback tĩnh | `packages/ai` provider discovery | model-catalog.ts: thêm `refresh()` async; lỗi network giữ catalogue tĩnh | test: mock server trả danh sách → catalog cập nhật; offline → fallback |

### Trụ cột 3 — TUI (đích: ngang hoặc hơn opencode)

**Hiện trạng**: Ink 8 + React 19, streaming, markdown, themes, keybinds, diff cards (S6) — nhưng app.tsx khổng lồ (W2), command duplicate (W3), render cap 200 (W13), thiếu mouse/vim/approval UX.

| # | Thay đổi | Nguồn tham chiếu opencode | Cách tích hợp | Tiêu chí nghiệm thu |
|---|---|---|---|---|
| T1 | **Slash-command registry dùng chung REPL + TUI**: `src/commands.ts` — mỗi command 1 object `{name, aliases, args, desc, run(ctx)}`; REPL + TUI chỉ render/execute; xoá 3 bản copy | `packages/core/src/command.ts` | Tạo registry; migrate 13+ lệnh; TUI autocomplete đọc từ registry | test: mọi command chạy được cả 2 frontend; grep không còn if-chain |
| T2 | **Tách app.tsx thành components**: `tui/components/` — ChatPane, PermissionModal, ReviewPanel (state machine /review), BuildRail, MetricsBar, InputArea; app.tsx còn wire + layout | `packages/tui` (component-based) | Tách dần, mỗi component 1 file + test state riêng | app.tsx < 400 dòng; tui-state.test mở rộng cho ReviewPanel |
| T3 | **Permission approval inline diff**: modal hiển thị full unified diff có màu, scroll được, chọn Allow once / Allow session / Deny; không cắt 12 dòng | `packages/tui` permission/diff UX | PermissionModal nhận diff props; reuse diff.ts renderer; thêm scroll box | test PTY: diff dài scroll được; 3 lựa chọn trả đúng effect |
| T4 | **Bỏ render cap 200**: virtualized list — chỉ render window quanh viewport (tính offset theo item height đã cache), state giữ full | Ink `useBoxMetrics` có sẵn | `ChatPane` render window ±50 items quanh scroll; cache height | test: 1000 items, scroll lên đầu vẫn thấy item đầu; FPS không tụt (measure flush time) |
| T5 | **Vim-motion + mouse trong InputArea**: mode normal/insert (Esc/i), di chuyển con trỏ theo từ, mouse wheel scroll ChatPane | opencode TUI hỗ trợ vim input | Thêm keymap layer vào Input; mouse event qua stdin raw-mode | test PTY: dot-motion cơ bản; wheel scroll không phá alternate buffer |
| T6 | **Tool progress per-call**: mỗi tool đang chạy có spinner + elapsed + tiêu đề ngắn; parallel tools hiển thị đồng thời | `packages/tui` tool call card | AgentEvent `tool_start/tool_end` đã có; ChatPane render card riêng | test state: 3 tool song song → 3 card; elapsed đúng |
| T7 | **Render image trong chat**: tool read ảnh → render qua `@joshday/ink-image` hoặc halfblock Sixel nếu terminal hỗ trợ, fallback link | opencode hỗ trợ image | detect terminal protocol (kitty/sixel/iterm); fallback path text | test: terminal không hỗ trợ → fallback không crash |
| T8 | **Theme pack mở rộng + 256color/truecolor detect**: thêm 3 theme (light, high-contrast, solarized), detect COLORTERM, expose `/theme list` | `packages/theme` (opencode có nhiều theme) | theme.tsx: thêm pack, query terminal caps | test: theme không đủ màu → degrade đúng |

### Trụ cột 4 — Vận hành MCP & Skill (đích: enterprise)

**Hiện trạng**: MCP chỉ stdio, không reconnect/hot-reload/validate (W10); skills không hot-reload, thiếu metadata chuẩn.

| # | Thay đổi | Nguồn tham chiếu opencode | Cách tích hợp | Tiêu chí nghiệm thu |
|---|---|---|---|---|
| M1 | **MCP reconnect + health check**: process chết → exponential backoff reconnect (max 5), health check định kỳ `ping`, tool list refresh sau reconnect; pending calls reject rõ ràng | `packages/core/src/mcp/client.ts` + `stdio.ts` | mcp.ts: thêm state machine `connecting|ready|reconnecting|dead`; surface event lên AgentEvent | test mock server kill/restart: client reconnect, call sau reconnect thành công |
| M2 | **MCP inputSchema validation**: trước `tools/call`, validate args theo `inputSchema` (tự viết validator JSON-Schema subset, không thêm dep); lỗi → trả tool error, không gọi server | `packages/core/src/tool/mcp.ts` | validator module `src/json-schema.ts` (~100 dòng: type/required/properties/enum) | test: sai type → error local; đúng schema → call qua |
| M3 | **MCP HTTP/SSE transport** (backlog P2 → làm): `url` + header trong config, SSE stream + JSON-RPC | `packages/core/src/mcp/` (socket-client, oauth) | mcp.ts: tách transport interface `StdioTransport | HttpTransport`; config `type: stdio|http` | test: mock HTTP MCP server handshake + call |
| M4 | **MCP/Skill hot-reload**: watch `.scoderrc` + `.scoder/skills/` (fs.watch, debounce 500ms); MCP server thay đổi → restart đúng server đó; skill mới → advertise lại system prompt turn sau | `config/watch.ts` + `skill/discovery.ts` | skills.ts: `discover()` thành method gọi lại được; mcp.ts: `restart(id)` | test: thêm SKILL.md giữa session → turn sau dùng được |
| M5 | **Skill metadata chuẩn Anthropic**: frontmatter thêm `allowed-tools`, `license`, `when-to-use`; validate trùng name + description rỗng → warn, không load | `skill-file.ts` + `skill.ts` schema | skills.ts: mở rộng parser; conflict → warn vào log | test: 2 skill trùng name → warn + project wins; thiếu description → skip + warn |
| M6 | **MCP OAuth** (đevice flow) cho remote servers — chỉ làm khi M3 xong và có nhu cầu thực | `packages/core/src/mcp/oauth.ts` | Đẩy sang P3 nếu chưa có server thực cần OAuth | — |

---

## 3. Lộ trình thực hiện

### Giai đoạn 0 — Refactor nền (tuần 1-2) — bắt buộc trước khi kéo code opencode
- **G1** tracker → GuardrailEngine (agent.ts mỏng đi ~150 dòng)
- **I2** tool registry + ToolContext (xoá `setTaskRunner` global — chặn R2)
- **T1** command registry dùng chung
- **I1** ProviderRuntime interface (xoá casts)
- Deliverable: `agent.ts` < 800 dòng, `tools.ts` < 300 dòng, 0 circular import core→tui (W5: dời `at-complete.ts` ra `src/`)
- Nhân sự: 1 dev chính + review. Test: toàn bộ suite hiện tại + test mới cho ToolContext.

### Giai đoạn 1 — Security hardening (tuần 2-3)
- **G2** hợp nhất permission schema
- **G3** redact run_command + env filtering
- **G5** MCP qua permission
- **G4** sandbox detection layer
- Deliverable: secrets không thể vào conversation/log qua bất kỳ đường nào; readonly mode không ghi ra ngoài workspace.
- Nhân sự: 1 dev + security review. Milestone: security audit checklist pass.

### Giai đoạn 2 — Harness + Intelligence (tuần 3-5)
- **G6** async/budget rules; **G7** config thresholds
- **I3** prompt-builder; **I4** compaction %; **I5** steering module; **I6** model catalog động
- Deliverable: eval suite (doom-loop, completion-claim, steering, subagent) pass; session dài 100+ turn không mất goal.

### Giai đoạn 3 — TUI (tuần 5-7)
- **T2** tách components; **T3** approval diff inline; **T4** virtualized list; **T6** tool progress; sau đó T5 vim/mouse, T7 image, T8 theme
- Deliverable: app.tsx < 400 dòng; diff dài review được trọn vẹn; 1000-item history scroll ok.

### Giai đoạn 4 — MCP/Skill vận hành (tuần 7-8)
- **M1** reconnect; **M2** schema validation; **M4** hot-reload; **M5** skill metadata
- **M3** HTTP/SSE transport (có thể kéo sang sprint sau)
- Deliverable: server chết giữa session tự hồi phục; skill thêm nóng dùng được turn sau.

### Milestone tổng
| Mốc | Tuần | Deliverable |
|---|---|---|
| MS0 | 2 | Refactor nền xong, coverage ≥ 90% giữ vững |
| MS1 | 3 | Security audit pass (sandbox fallback + redaction + MCP permission) |
| MS2 | 5 | Harness ≈ opencode (runner/policy tách), Intelligence ≈ opencode |
| MS3 | 7 | TUI ngang opencode (components, approval UX, virtualized) |
| MS4 | 8 | MCP/Skill vận hành enterprise |

---

## 4. Kế hoạch kiểm thử & chất lượng

### 4.1 Ngưỡng chất lượng
- Coverage: giữ ≥ 90% line / ≥ 80% branch (mọi PR không làm giảm).
- Static: `tsc --noEmit` strict 0 lỗi; eslint 0 warning; cấm `as any`/`@ts-ignore` (đã có, giữ rule CI).
- Benchmark: flush time TUI < 50ms ở 1000 items; reconnect MCP < 5s.

### 4.2 Test mới bắt buộc theo từng trụ cột
- **Harness**: secret-via-stdout redaction; env allowlist; sandbox readonly; MCP-permission readonly; budget rule.
- **Intelligence**: ToolContext multi-run isolation; prompt-builder snapshot; compaction trigger %; steering giữa parallel calls.
- **TUI**: PTY test cho approval-diff scroll; virtualized 1000 items; vim keymap dot-motion.
- **MCP/Skill**: kill/restart reconnect; schema validation; hot-reload skill giữa session; duplicate skill name.

### 4.3 Quy trình
- CI giữ matrix node 20/22 + e2e + mcp-test + eval (đã có). Thêm job `coverage` fail dưới ngưỡng.
- Code review: mọi thay đổi security (G2-G5) cần 2 approver.
- Audit bảo mật trước MS1: checklist OWASP CLI top risks + secret scan `scripts/check-secrets.mjs` chạy pre-commit + CI.

### 4.4 Rollback
- Mỗi giai đoạn 1 branch + tag; feature flag rc (`experimental.sandbox`, `experimental.virtualized`) để tắt nhanh không cần revert.
- Session JSONL schema version hoá (`schemaVersion` field) — migration script khi đổi.

---

## 5. Rủi ro & giảm thiểu

| Rủi ro | Khả năng | Ảnh hưởng | Giảm thiểu |
|---|---|---|---|
| Kéo code opencode không tương thích (opencode dùng Bun + Effect + drizzle; scoder thuần Node + no-framework) | Cao | Cao | **Không kéo nguyên module** — chỉ tham chiếu pattern (runner/policy split, state machine, validator). Mọi port viết lại theo Node stdio, giữ 0 new dep trừ khi bắt buộc |
| Refactor agent.ts làm regression permission/guardrail | Trung bình | Cao | Giai đoạn 0 làm trước + suite 200+ fuzz case làm safety net; refactor từng bước có test |
| Sandbox binary không có trên máy user | Cao | Trung bình | G4 detection + fallback warn, không fail; tài liệu hoá cài đặt |
| Virtualized list phá Ink layout cũ | Trung bình | Trung bình | Feature flag `experimental.virtualized`; PTY test trước merge |
| MCP HTTP/OAuth scope lớn hơn dự kiến | Cao | Thấp | M3/M6 là mục cuối, tách sprint; stdio vẫn là default |
| Giới hạn thời gian 3 tháng | — | — | Giai đoạn 0-2 (8 tuần) là core enterprise; T5/T7/T8 + M3/M6 có thể cắt không ảnh hưởng mục tiêu |

---

## Phụ lục A — Mapping opencode → scoder (kéo gì, kéo thế nào)

| opencode module | Pattern cần lấy | Port vào scoder |
|---|---|---|
| `packages/core/src/session/runner/step.ts`, `max-steps.ts` | Runner tách khỏi policy | G1: engine.observe/decide |
| `packages/core/src/permission.ts`, `v1/config/permission.ts` | Một schema permission duy nhất | G2 |
| `packages/core/src/environment/environment.ts`, `exec-defaults.ts` | Env driver + exec defaults | G3, G4 |
| `packages/core/src/tool/plugin/*` (mỗi tool 1 file) | Tool registry per-file | I2 |
| `packages/core/src/command.ts` | Command registry chung | T1 |
| `packages/tui` | Component-based TUI, permission UX | T2, T3 |
| `packages/core/src/session/compaction.ts` | Compaction theo context window | I4 |
| `packages/core/src/session/runner/llm.ts`, `retry.ts` | Steering + retry policy | I5 |
| `packages/core/src/mcp/client.ts`, `stdio.ts` | MCP state machine reconnect | M1 |
| `packages/core/src/config/plugin/skill-file.ts`, `skill.ts` | Skill schema + validation | M5 |
| `packages/core/src/config/watch.ts` | Config hot-reload | M4 |
| `packages/theme` | Theme pack structure | T8 |

## Phụ lục B — Thứ tự PR đề xuất
1. `refactor/tool-context` (I2) — chặn bug server-mode trước.
2. `refactor/guardrail-observe` (G1).
3. `refactor/command-registry` (T1).
4. `feat/permission-unify` (G2) — PR lớn, 2 approver.
5. `feat/redact-exec-env` (G3) — nhỏ, ship ngay.
6. `feat/sandbox-layer` (G4).
7. `feat/mcp-permission` (G5).
8. `feat/prompt-builder` (I3) → `feat/compaction-pct` (I4) → `feat/steering-module` (I5).
9. `feat/provider-runtime-iface` (I1) → `feat/model-catalog-dynamic` (I6).
10. `refactor/tui-components` (T2) → `feat/approval-diff` (T3) → `feat/virtualized-list` (T4) → còn lại.
11. `feat/mcp-reconnect` (M1) → `feat/mcp-schema-validate` (M2) → `feat/hot-reload` (M4) → `feat/skill-metadata` (M5).
