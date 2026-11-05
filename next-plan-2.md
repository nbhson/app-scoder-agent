# Next Plan 2 — scoder 0.9 → 1.0 (Kế hoạch chi tiết triển khai)

> Trạng thái: draft · Baseline: 0.9.0 · Cập nhật: 2026-11-05
> File này là bản **mở rộng chi tiết** từ `next-plan.md`. Giữ nguyên cấu trúc, đánh số, ký hiệu và trạng thái checklist (`[x]`/`[ ]`) của file gốc; bổ sung mô tả, task cụ thể, người chịu trách nhiệm, thời gian ước tính, rủi ro & phụ thuộc cho từng mục.
> Thứ tự ưu tiên: Agent → MCP → Command/Skill → TUI

---

## 0. Tóm tắt điều hành

### 0.1. Bốn trụ nâng cấp (giữ nguyên từ file gốc)

| Trụ | Mục tiêu | Ưu tiên | Effort |
|---|---|---|---|
| **Agent intelligence** | Agent tự hiểu repo, lập kế hoạch tốt hơn, tự kiểm chứng, tự sửa, biết hỏi user, biết delegate | **P0 — quan trọng nhất** | ~20 dev-days |
| **MCP** | Đủ protocol (resources/prompts/notifications), streaming thật, governance + bảo mật | P1 | ~9 dev-days |
| **Command/Skill** | Một registry duy nhất, custom command, skill 2.0, completion thống nhất | P1 | ~6 dev-days |
| **TUI** | Hiển thị đầy đủ event mới, command palette, transcript search/expand, a11y | P1 | ~8 dev-days |
| **Hardening** | Eval gate, docs, migration, release | P0 | ~3 dev-days |

**Kết quả kỳ vọng:** task success rate +15–25% trên eval suite; median steps −20%; false-done rate = 0; MCP first-call success ≥98%; TUI không rớt frame khi stream.

### 0.2. Lý do và thứ tự ưu tiên

- **Agent (P0, làm trước):** là lõi giá trị của sản phẩm; mỗi % success tăng là giá trị trực tiếp cho người dùng. Các trụ khác đều cần hiển thị/hiểu agent nên phụ thuộc vào phần này.
- **Hardening (P0):** eval gate + docs là "bộ phanh" để các trụ còn lại đổ về mà không vỡ chất lượng.
- **MCP (P1):** mở rộng cổng kết nối công cụ ngoài; làm sau Agent để tận dụng context/hiểu biết đã có.
- **Command/Skill (P1) rồi TUI (P1):** lớp trải nghiệm; cần event/schema từ các trụ trước mới hiển thị đúng.

### 0.3. KPI đo lường thành công

| KPI | Baseline hiện tại | Mục tiêu | Cách đo |
|---|---|---|---|
| Task success rate | ~50% (ước lượng) | ≥ +15% so với baseline | `test/run-eval.mjs` |
| Median steps / task | ~12 | −20% | eval JSONL |
| False-done rate | > 0 | = 0 | eval + completion gate |
| MCP first-call success | ~90% | ≥ 98% | mock suite logic |
| TUI scroll 10k events | ~có lag | 0 lag, frame ≤ 50ms | PTY perf test |

### 0.4. Nguồn lực & khung thời gian

| Quy mô | Thời gian | Ghi chú |
|---|---|---|
| 1 dev | ~9–10 tuần | Tuần tự từng phase |
| 2 devs | ~5 tuần | Dev A: Agent; Dev B: MCP + Command/Skill (sau Phase 0) |

**Giả định:** 1 dev-day ≈ 8 giờ tập trung; không tính thời gian review/QA nội bộ vào effort (tính riêng trong phase gate).

---

## 1. Baseline & khoảng trống đã xác nhận

### 1.1. Bảng tổng hợp (giữ nguyên từ file gốc)

| Khu vực | Đang có | Thiếu / vấn đề |
|---|---|---|
| **Agent** | Closed-loop, guardrails, compaction, subagent `task`, steering, snapshots, 3 built-in agent | Prompt tĩnh; không có `AGENTS.md`; không chọn primary agent; không có repo map/symbol index; `read_file` đọc cả file; plan chỉ là todo list; verify chỉ build; không có self-review; memory sau compaction mất cấu trúc |
| **MCP** | stdio + HTTP, reconnect, schema validate, hot reload, permission cho `mcp__*` | Chỉ `tools/*`; không resources/prompts/notifications; HTTP đọc `res.text()` (buffer cả SSE); không progress/cancel; `structuredContent` bị bỏ; readonly vẫn spawn server; `applyConfig` không restart server khi config đổi; prompt chỉ liệt kê tên server |
| **Command/Skill** | `/help`, `/compact`, `/mcp`, `/skill`…; skill frontmatter đơn giản; hot reload skills | 2 danh sách command dễ lệch (`tui/commands.ts` vs `tui/command-registry.ts`); TUI hardcode `/review`, `/diff`, `/theme`, `/undo`; không custom command; skill không progressive disclosure; `allowed-tools` chỉ để hiển thị |
| **TUI** | Mission Control, sidebar, virtual scroll, diff card, image, vim, mouse wheel, theme | Reducer bỏ qua `steer_queued`/`steer_delivered`; không có event compaction/subagent; tool card không expand/collapse; không search/copy/export; `/review` hardcode server `prompt-gate` + `language: "vietnamese"`; height estimate là heuristic |

### 1.2. Phân tích tác động của từng khoảng trống

| # | Khoảng trống | Tác động hiện tại | Mức |
|---|---|---|---|
| 1 | Prompt tĩnh, không tách section | Khó tinh chỉnh per-task; thay đổi rủi ro cả system | Cao |
| 2 | Không repo map / symbol index | Agent đọc 5–10 file để tìm 1 symbol → tốn token, chậm | Cao |
| 3 | `read_file` đọc cả file | Context phình nhanh với file lớn | Trung bình |
| 4 | Plan chỉ là checklist | Agent "xong" khi chưa verify → false-done | Cao |
| 5 | MCP thiếu resources/prompts/notifications | Không tương thích đầy đủ với hệ sinh thái MCP | Trung bình |
| 6 | HTTP MCP buffer cả SSE | Chậm, không streaming được, memory tốn | Trung bình |
| 7 | `structuredContent` bị bỏ | Mất dữ liệu có cấu trúc từ tool MCP | Thấp |
| 8 | Readonly vẫn spawn server | Rò rỉ bảo mật khi chỉ cần đọc | Cao (security) |
| 9 | 2 danh sách command dễ lệch | `/help` thiếu/trùng command | Trung bình |
| 10 | TUI bỏ qua event mới | Người dùng không thấy trạng thái thật của agent | Trung bình |

### 1.3. Kết luận xác nhận

- Phạm vi cố định: 4 trụ + hardening; không thêm trụ mới trong phase này.
- "Out of scope" phải giữ (mục 10): web UI, cloud sync, full LSP, vector DB/embeddings, MCP OAuth, multi-tenant auth.

---

## 2. Nguyên tắc triển khai

### 2.1. Nguyên tắc (giữ nguyên ý từ file gốc)

1. **Event-first:** mọi năng lực mới phải đi qua `AgentEvent` để REPL, TUI, `serve` cùng thấy.
2. **Một registry:** tool, command, skill, agent đều có metadata + handler + completion chung.
3. **Additive & backward-compatible:** event/config thêm field, không phá schema cũ; feature flag cho thay đổi lớn.
4. **Đo được:** mỗi thay đổi Agent phải có eval trước/sau; không merge nếu regression >5%.
5. **Security by default:** MCP readonly không spawn; tool lạ mặc định `ask`; output ngoài được đánh dấu untrusted.
6. **Không thêm runtime dependency nếu không cần:** ưu tiên tree-sitter có sẵn, `fetch`, `node:*`; dependency mới phải có ADR.

### 2.2. Cách áp dụng từng nguyên tắc

| Nguyên tắc | Áp dụng cụ thể | Khi nào bỏ qua |
|---|---|---|
| Event-first | Thêm `type` mới vào union `AgentEvent` trước khi code handler | Đổi nội bộ không cần UI (vd refactor) |
| Một registry | Mọi command/tool/skill khai báo `{metadata, handler, completion}` | Prototype 1 ngày, đánh dấu TODO |
| Additive & backward-compatible | Chỉ thêm optional field; giữ parser cũ chạy được với event mới | Trước khi release major |
| Đo được | Chạy eval baseline trước, sau mỗi PR agent | Thay đổi thuần docs/schema |
| Security by default | Mặc định `trust: "ask"`, readonly no-spawn | User chủ động allowlist |
| Ít dependency | Dùng tree-sitter có sẵn, `fetch`, `node:*` | Một dependency thật sự cần → ADR |

### 2.3. Rủi ro triển khai chung

| Rủi ro | Giảm thiểu |
|---|---|
| Nguyên tắc bị hiểu lệch giữa các dev | Viết checklist "Definition of Done" theo nguyên tắc ở mục 9; review gate |
| Ad-hoc code ngoài registry | Rule: tính năng mới được khai báo trong registry; lint bắt tính năng "trôi" |
| Feature flag quá nhiều | Số flag tối thiểu; mỗi flag phải có issue cleanup + deadline |

---

## 3. Trụ 1 — Agent intelligence (P0, làm trước)

### 3.0. Tổng quan trụ Agent

**Mô tả:** nâng agent từ "chạy được" thành "đáng tin cậy": hiểu repo, lập kế hoạch có kiểm chứng, nhớ lâu, tự sửa lỗi, biết hỏi và biết giao việc.

**Effort:** ~20 dev-days · **Phân bổ:** 3.1 (4d), 3.2 (4d), 3.3 (3d), 3.4 (3d), 3.5 (3d), 3.6 (2d), 3.7 (2d), 3.8 (3d — có thể chạy nền). Tổng ~24d, tiết giảm còn ~20d do 3.8 dùng lại từ Phase 0.

**Thứ tự làm trong trụ:** 3.8 (eval harness dựng sớm) → 3.1 → 3.2 → 3.7 → 3.3 → 3.4 → 3.5 → 3.6.

**Người phụ trách (đề xuất):** dev core agent (1 người chuyên, 1 người review).

**Cổng kiểm soát cho cả trụ:**
- Eval baseline trước/sau mỗi mục; regression >5% → không merge.
- Feature flag cho thay đổi prompt/behavior lớn (`promptVersion`, `agent*` enable) để rollback nhanh.

---

### 3.1. Agent profiles & routing

#### Mục tiêu & lý do

**Mô tả:** biến `AgentDef` từ "prompt cho subagent" thành **agent hạng nhất** chọn được, có model/tool/permission riêng. Lý do: hiện mọi chế độ dùng chung prompt/tool, không tối ưu theo vai trò (plan nên rẻ + read-only; build nên mạnh; review nên khác provider).

#### Công việc cụ thể

- Mở rộng `AgentDef`:
  `tools?: string[]`, `permission?: PermissionMode`, `temperature?`, `reasoning?`, `maxTokens?`, `skills?: string[]`, `color?`.
- Thêm `config.agent` + CLI `--agent <name>`; TUI `/agent [name]` mở picker.
- Chỉ cho chọn agent `mode: primary | all`; `subagent` chỉ dùng qua `task`.
- Agent `plan` phải **read-only ở tầng tool**, không chỉ permission: filter `allToolSpecs()` bỏ `write_file`, `edit_file`, `run_command` mutating.
- Per-agent model: `plan` dùng model rẻ; `build` model mạnh; `review` model rẻ/khác provider.
- Khi đổi agent giữa session: nếu đang chạy → chặn; nếu idle → reset system prompt + tool list, giữ history (hoặc fork session nếu user muốn).

#### Chi tiết task phụ (task breakdown)

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Mở rộng type `AgentDef` + validate schema | Type + tests | S |
| 2 | `--agent` CLI + `config.agent` | parse + pip vào session | M |
| 3 | `/agent [name]` picker (TUI) | command trong registry | M |
| 4 | Tool filter read-only cho agent `plan` | filter trong `allToolSpecs()` | S |
| 5 | Per-agent model routing hook sẵn | `agent.model` trong run | M |
| 6 | Đổi agent lúc idle: reset prompt + tool list, giữ history | logic + test | L |

**Người chịu trách nhiệm:** core dev (task 1–6) + TUI dev (task 3).

**Thời gian dự kiến:** 4 dev-days.

**Phụ thuộc:** Phase 0 (event schema, registry skeleton), config schema additive.

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Filter tool read-only bị "build" len lỏi | Unit test đảm bảo `plan` không sở hữu tool mutating |
| Đổi agent giữa chừng mất context | Chỉ cho đổi khi idle; fork session là tuỳ chọn có xác nhận user |
| Config mới phá config cũ | Giữ field cũ hoạt động; migration test |

#### Acceptance (giữ nguyên từ file gốc)

- `scoder --agent plan "..."` không bao giờ ghi file.
- `/agent` liệt kê đúng primary agents, đổi được khi idle.
- Subagent kế thừa đúng tool filter + model + `allowSubagents:false`.

**File chính:** `src/agents.ts`, `src/config.ts`, `src/agent.ts`, `src/index.ts`, `src/tui/command-registry.ts`.

---

### 3.2. Repo understanding & context assembly

#### Mục tiêu & lý do

**Mô tả:** giảm số lần đọc file mò, đưa đúng context ngay từ đầu. Lý do: thời gian & token lớn nhất đang rơi vào "tìm đúng file/symbol".

#### Công việc cụ thể

- **`AGENTS.md` hierarchy:** `~/.scoder/AGENTS.md` → `<workdir>/AGENTS.md` → `AGENTS.md` gần file đang sửa. Inject phần liên quan, không nuốt toàn bộ.
- **Repo map:** file tree + symbol outline (tree-sitter cho TS/JS nếu grammar có; fallback regex cho Python/Go/Rust). Cache theo mtime, budget ~2–4k tokens.
- **Context pack:** chọn file theo task keywords + symbol hits + recent edits + test files; không inject cả repo.
- Nâng `read_file`: `offset`, `limit`, `max_lines`; trả line range thay vì cả file.
- Nâng `grep`: `context_before/after`, `max_results`, `type`, đường dẫn tương đối.
- Nâng `list_files`: `depth`, `exclude`, `include_hidden`.
- Thêm tool `repo_map` hoặc inject bản rút gọn vào system prompt.
- Cache + dedupe tool result theo `(tool, args, mtime)`; invalidate khi write/edit.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | `AGENTS.md` hierarchy + merge theo độ gần file | module merge + test | M |
| 2 | Repo map: tree + symbol outline, cache mtime | `src/repo-map.ts` | L |
| 3 | Fallback regex cho Python/Go/Rust | parser fallback | M |
| 4 | Context pack: scoring file theo keyword/symbol/edit/test | module + unit test | M |
| 5 | `read_file` range (`offset/limit/max_lines`) | tool schema + handler | S |
| 6 | `grep` context/max/type/relative path | tool schema + handler | S |
| 7 | `list_files` depth/exclude/include_hidden | tool schema + handler | S |
| 8 | Tool `repo_map` + prompt injection ngắn | tool + prompt section | M |
| 9 | Cache result keys `(tool,args,mtime)` + invalidation | cache layer + test | M |

**Người chịu trách nhiệm:** core dev (1–4, 9), tools dev (5–8).

**Thời gian dự kiến:** 4 dev-days.

**Phụ thuộc:** tree-sitter grammar sẵn có; eval scenario "tìm symbol".

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Repo map tốn token vượt budget | Budget cứng 2–4k; trunction + đặt sau context pack |
| Cache stale | Invalidate theo mtime + hook sau write/edit |
| Grammar thiếu cho ngôn ngữ | Fallback regex có test riêng |

#### Acceptance (giữ nguyên từ file gốc)

- Trên eval "tìm symbol X", agent đạt kết quả trong ≤2 tool calls thay vì đọc 5–10 file.
- Repo map không làm system prompt vượt budget đã định.

### 3.3. Planning 2.0

#### Mục tiêu & lý do

**Mô tả:** plan có **acceptance + verification**, không chỉ checklist. Lý do: false-done chủ yếu đến từ "plan xong việc mà không nói cách xác minh xong".

#### Công việc cụ thể

- Mở rộng schema `write_todos`:

  ```ts
  { id, content, status, verify?: string, depends_on?: string[], files?: string[], acceptance?: string }
  ```

- Bắt buộc plan trước edit với task multi-step: guardrail mềm inject nhắc nếu chưa có plan.
- Chỉ 1 `in_progress`; plan update phải kèm lý do nếu đổi thứ tự.
- Lưu plan vào session v2; resume khôi phục.
- `/plan` để xem, sửa, mark step; sidebar hiển thị đúng thứ tự và trạng thái.
- Replan rule: sau 2 lần verify fail hoặc phát hiện file mới → bắt buộc cập nhật plan.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Mở rộng `write_todos` schema + validate | schema + test | M |
| 2 | Guardrail "thiếu plan" (mềm, inject nhắc) | guardrail + prompt | S |
| 3 | Rule 1 `in_progress` + lý do đổi thứ tự | logic + test | S |
| 4 | Persist plan v2 vào session; resume | persistence + test | M |
| 5 | `/plan` xem/sửa/mark step | command + host | M |
| 6 | Sidebar hiển thị verify/acceptance/thứ tự | state + sidebar | M |
| 7 | Replan rule sau 2 verify-fail/ file mới | guardrail + test | M |

**Người chịu trách nhiệm:** core dev (1–4, 7), TUI dev (5–6).

**Thời gian dự kiến:** 3 dev-days.

**Phụ thuộc:** 3.1 (agent), session v2 (3.4), 6.3 (transcript).

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Guardrail mềm bị agent "lờ đi" | Log + nhắc lần 2; hiện lên TUI |
| Plan cũ không tương thích khi resume | Migration plan v1→v2 trong session loader |

#### Acceptance (giữ nguyên từ file gốc)

- Plan hiển thị đầy đủ verify/acceptance trong TUI.
- Task multi-file có plan trước lần edit đầu tiên.

**File chính:** `src/tools.ts` (`write_todos`), `src/agent.ts`, `src/guardrails.ts`, `src/tui/state.ts`, `src/tui/sidebar.tsx`.

---

### 3.4. Memory & compaction 2.0

#### Mục tiêu & lý do

**Mô tả:** không mất quyết định/bối cảnh sau compaction hoặc resume. Lý do: compaction hiện nén thành một đoạn văn → mất chi tiết "đã sửa file nào / quyết định gì".

#### Công việc cụ thể

- Thêm `src/memory.ts`:

  ```ts
  WorkingMemory = {
    goal, constraints[], decisions[], filesRead[], filesChanged[],
    failures[], openQuestions[], nextSteps[]
  }
  ```

- Cập nhật memory từ tool result, guardrail, plan; inject bản rút gọn (≤1.5k tokens) mỗi N bước hoặc trước compaction.
- Compaction v2: summary theo template cấu trúc (goal/state/changed/decisions/failures/next), **giữ nguyên ledger**; không chỉ một đoạn văn.
- Persist memory vào event log v2; resume khôi phục.
- Retrieval budget rõ ràng: memory ≤1.5k, repo map ≤2k, skill index ≤1k.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | `WorkingMemory` type + cập nhật từ các nguồn | `src/memory.ts` | L |
| 2 | Inject bản rút gọn mỗi N bước / trước compaction | prompt-builder hook | M |
| 3 | Compaction v2 theo template + giữ ledger | compaction logic + test | L |
| 4 | Persist memory vào event log v2; resume | session + test | M |
| 5 | Budget rõ ràng mỗi retrieval channel | hằng số budget + test | S |

**Người chịu trách nhiệm:** core dev (1–5).

**Thời gian dự kiến:** 3 dev-days.

**Phụ thuộc:** 3.2 (context budget), event log v2 (Phase 0).

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Ledger phình khi running lâu | Budget + cprune; chỉ giữ filesChanged/decisions gần nhất |
| Inject nhiều làm loãng prompt | Cắt theo budget; test eval compaction 8/10 |

#### Acceptance (giữ nguyên từ file gốc)

- Resume sau compaction trả lời đúng "đã sửa file nào / quyết định gì / lỗi nào".
- Eval compaction: 10 câu hỏi về history cũ, đúng ≥8/10.

**File chính:** new `src/memory.ts`, `src/compaction.ts`, `src/agent.ts`, `src/session.ts`.

---

### 3.5. Verification & self-correction

#### Mục tiêu & lý do

**Mô tả:** agent không "nói xong" khi chưa kiểm chứng; tự sửa lỗi thay vì lặp. Lý do: nguồn false-done lớn nhất là tin "text model nói xong" thay vì "build/test thực sự xanh".

#### Công việc cụ thể

- `src/diagnostics.ts`: parse `tsc`, `eslint`, `pytest`, `go test`, `cargo` → `{file,line,severity,code,message}`.
- Detect verify commands: build + test + lint/typecheck từ `package.json`, `pyproject.toml`, `Cargo.toml`, `Makefile`; config `verifyCmds`.
- Completion gate: build + test (nếu có) + không còn diagnostic blocking; `completion-claim` dùng kết quả verify, không dùng text.
- Self-review pass: sau edit, trước finish, chạy review trên diff + acceptance; nếu fail → inject findings.
- Error classifier: syntax/type/test/runtime/permission/network → chiến lược (đọc thêm, sửa, retry, hỏi user, dừng).
- Guardrail `no-progress`: không đổi file + cùng lỗi + token burn → đổi hướng hoặc dừng.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Parser diagnostics cho tsc/eslint/pytest/go test/cargo | `src/diagnostics.ts` + test | L |
| 2 | Detect verify commands theo project type | detector + config `verifyCmds` | M |
| 3 | Completion gate (build+test+no-blocking) | gate + event usage/verification | L |
| 4 | Self-review pass trước finish | review loop + text | M |
| 5 | Error classifier → chiến lược | classifier + prompt | M |
| 6 | Guardrail `no-progress` | guardrail + test | M |

**Người chịu trách nhiệm:** core dev (1–3), guardrail dev (4–6).

**Thời gian dự kiến:** 3 dev-days.

**Phụ thuộc:** 3.3 (acceptance), eval (3.8) để chứng minh.

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Parser lỗi cú pháp đa dạng | Test golden từ log thật; fallback raw log |
| Completion gate quá khắt khe chặn việc hoàn thành | Chỉ chặn blocking diagnostics; cho override có lý do |

#### Acceptance (giữ nguyên từ file gốc)

- Eval seeded bug: fix trong ≤N bước, không false-done.
- Khi build fail, agent nhận structured diagnostics thay vì raw log.

**File chính:** new `src/diagnostics.ts`, `src/build.ts`, `src/guardrails.ts`, `src/agent.ts`, `src/tools.ts`.

### 3.6. Delegation & tool intelligence

#### Mục tiêu & lý do

**Mô tả:** cho agent giao việc con một cách an toàn và làm tool thông minh hơn (fuzzy, atomic, structured result). Lý do: phân việc song song giảm thời gian; tool "dễ vỡ" (edit chính xác tuyệt đối) là nguồn lỗi lặp.

#### Công việc cụ thể

- `task` tool: hỗ trợ batch `tasks: [...]`, chạy bounded concurrency, merge kết quả; emit `agent_start/agent_end`.
- Auto chọn agent: explore cho tìm kiếm, review cho diff, plan cho thiết kế; validate agent tồn tại.
- Hiển thị `description` của subagent trong TUI (hiện chỉ có tag).
- Thêm `ask_user` tool: `{question, options?, multiple?, timeoutSecs?}`; TUI modal, REPL prompt, server trả lỗi rõ nếu không interactive.
- `edit_file`: fuzzy fallback (chuẩn hóa whitespace) + báo lỗi gần đúng; thêm `apply_patch` cho multi-hunk.
- `read_file` range; `write_file` atomic; `run_command` trả exit code/duration có cấu trúc.
- Sửa schema `timeout_secs` từ `string` → `number` cho đúng handler.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | `task` batch + bounded concurrency + merge | tool + event + test | L |
| 2 | Auto chọn agent theo loại việc + validate | routing helper | S |
| 3 | TUI hiển thị `description` subagent | sidebar/state | S |
| 4 | `ask_user` tool + TUI modal + REPL prompt | tool + host + test | L |
| 5 | `edit_file` fuzzy fallback + lỗi gần đúng | tool + test | M |
| 6 | `apply_patch` multi-hunk | tool + test | M |
| 7 | `read_file` range; `write_file` atomic; `run_command` structured | tool + test | M |
| 8 | Sửa schema `timeout_secs` sang number | schema + migration test | S |

**Người chịu trách nhiệm:** tools dev (4–8), core dev (1–3).

**Thời gian dự kiến:** 2 dev-days.

**Phụ thuộc:** 3.1 (agents), event mới compaction/agent (Phase schema 7), TUI (6.5) cho modal.

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Batch subagent giẫm event/message | Mỗi subagent đóng gói event riêng; test song song |
| `ask_user` block không interactive (server) | Trả `409`/`not-interactive` rõ ràng |

#### Acceptance

- 2 subagent chạy song song không giẫm event/message.
- `ask_user` hoạt động ở TUI + REPL; server trả `409`/`not-interactive`.

**File chính:** `src/tools.ts`, `src/agent.ts`, `src/tui/state.ts`.

### 3.7. Prompt V5 & model strategy

#### Mục tiêu & lý do

**Mô tả:** cấu trúc lại prompt theo section có ID + budget, thêm decision policy, anti-hallucination, và điều hướng model theo phase. Lý do: prompt hiện là một khối, khó A/B và dễ regress toàn cục.

#### Công việc cụ thể

- Tách prompt thành các section có ID + budget: identity, workflow, tool policy, safety, scope, verification, memory, skills, MCP, output.
- Thêm decision policy: khi nào plan, khi nào hỏi, khi nào dừng, ngôn ngữ trả lời theo user.
- Thêm anti-hallucination: không bịa API/path; phải verify bằng tool.
- `PROMPT_VERSION = 5`; log version vào session; A/B bằng eval.
- Model routing: `routing: { plan, build, review }`; fallback provider khi lỗi; cost/token budget theo phase.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Chia section prompt + budget | prompt-builder | M |
| 2 | Decision policy (plan/ask/stop/language) | prompt section | M |
| 3 | Anti-hallucination wording | prompt section | S |
| 4 | `PROMPT_VERSION=5` + log session + A/B | versioning + eval | M |
| 5 | `routing` config + fallback provider | provider-registry | M |
| 6 | Cost/token budget theo phase | budget config | S |

**Người chịu trách nhiệm:** core dev.

**Thời gian dự kiến:** 2 dev-days.

**Phụ thuộc:** eval (3.8) để A/B; config (3.1) cho routing.

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Prompt V5 regress | Eval gate + feature flag `promptVersion`; rollback V4 |
| Routing đổi khó | Config-only; không cần sửa code khi đổi model |

#### Acceptance

- Eval V5 ≥ V4 trên success rate; không tăng median tokens quá 10%.
- Đổi `routing` không cần sửa code.

**File chính:** `src/prompt.ts`, `src/prompt-builder.ts`, `src/config.ts`, `src/agent.ts`, `src/provider-registry.ts`.

### 3.8. Eval harness

#### Mục tiêu & lý do

**Mô tả:** bộ đo lường định lượng để mọi thay đổi Agent đều được kiểm chứng trước/sau. Lý do: không có số liệu → không biết "cải thiện" hay "hồi quy".

#### Công việc cụ thể

- `test/eval/scenarios/*.json`: bugfix, feature, refactor, test-failure, multi-file, MCP, permission.
- Metrics: success, steps, tokens, tool calls, error recovery, wall time, false-done.
- Mock LLM cho deterministic; nightly real-model eval; lưu JSONL.
- CI gate: regression >5% → fail; so sánh prompt version.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Khung scenarios JSON + runner | `test/run-eval.mjs` | L |
| 2 | Metrics collector + xuất JSONL | collector | M |
| 3 | Mock LLM deterministic | mock + golden | M |
| 4 | Nightly real-model eval script | CI job/cron | M |
| 5 | CI gate regression >5% | CI step | S |

**Người chịu trách nhiệm:** QA/CI dev, có core dev review kịch bản.

**Thời gian dự kiến:** 3 dev-days (chạy nền suốt trụ).

**Phụ thuộc:** scenarios cần từ 3.1–3.7; chạy được ngay từ đầu với baseline.

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Scenario phản ánh sai thực tế | Review scenario theo case thật; thêm case từ bug report |
| Eval tốn thời gian chạy | Nightly riêng; CI chỉ chạy 1 subset + gate |

#### Acceptance

- Eval suite ≥20 scenarios; success rate tăng ≥15%; median steps giảm ≥20%; false-done = 0.
- CI gate regression >5% → chặn merge (chỉ áp dụng cho thay đổi Agent).

**File chính:** `test/run-eval.mjs`, `test/eval/`.

---

## 4. Trụ 2 — MCP

### 4.0. Tổng quan trụ MCP

**Mô tả:** hoàn thiện protocol (resources/prompts/notifications), streaming thật, governance + bảo mật cho cổng MCP.

**Effort:** ~9 dev-days · **Phân bổ:** 4.1 (2d), 4.2 (2.5d), 4.3 (2d), 4.4 (1d), 4.5 (1d), 4.6 (0.5d).

**Thứ tự làm:** 4.4 (CLI/UX sớm để test dễ) → 4.1 → 4.2 → 4.3 → 4.5 → 4.6.

**Người phụ trách:** MCP dev chuyên trách, có security review cho 4.5.

---

### 4.1. Protocol completeness

#### Mô tả & lý do

**Mô tả:** bổ sung các khả năng protocol MCP còn thiếu (resources, prompts, notifications) để tương thích đầy đủ với hệ sinh thái.

#### Công việc cụ thể

- Negotiate `protocolVersion` (hỗ trợ 2024-11-05 + bản mới), lưu `serverInfo`, `instructions`, `capabilities`.
- Resources: `resources/list`, `resources/templates/list`, `resources/read`, `resources/subscribe`; expose tool `mcp__<server>__read_resource` hoặc tích hợp `@resource`.
- Prompts: `prompts/list`, `prompts/get`; expose qua `/mcp prompt` hoặc tool.
- Notifications: `tools/list_changed`, `resources/list_changed`, `resources/updated`, `message`, `progress`.
- Health: dùng `ping` thay vì `tools/list` làm liveness probe; latency metric.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Negotiate version + lưu serverInfo/instructions/capabilities | handshake state | M |
| 2 | Resources list/templates/read/subscribe + tool expose | resource layer + test | L |
| 3 | Prompts list/get + `/mcp prompt` | prompt layer + test | M |
| 4 | Notifications handling (list_changed, resources_*, message, progress) | dispatcher + test | M |
| 5 | Liveness bằng `ping` + latency metric | health + metric | S |

**Người chịu trách nhiệm:** MCP dev.

**Thời gian dự kiến:** 2 dev-days.

**Phụ thuộc:** Phase 0 (event schema), transport (4.2) cho notification.

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Server cũ không support version mới | Negotiate fallback về 2024-11-05 |
| Resources nhiều gây noise | Expose qua tool `read_resource` + query cụ thể |

**File:** `src/mcp.ts`, `src/agent.ts`, `src/tui/command-registry.ts`.

---

### 4.2. Transport hardening

#### Mô tả & lý do

**Mô tả:** làm transport HTTP/stdio chắc chắn: stream thật, cancel, reconnect thông minh, restart đúng.

#### Công việc cụ thể

- HTTP: parse SSE **incremental** thay vì `res.text()`; hỗ trợ GET stream cho server→client; xử lý session expiry; idle timeout per chunk; max body.
- Cancellation: `AbortSignal` → gửi `notifications/cancelled`; reject pending đúng cách.
- Reconnect: giữ backoff; thêm jitter; health check định kỳ; kill orphan process.
- `applyConfig`: restart server khi command/url/env/headers đổi, không chỉ add/remove.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | SSE incremental parser (ReadableStream) | parser + test | L |
| 2 | GET stream server→client | transport | M |
| 3 | Session expiry + idle timeout + max body | transport guard | M |
| 4 | Cancellation → `notifications/cancelled` + reject pending | cancel path + test | M |
| 5 | Reconnect backoff + jitter + health check + kill orphan | reconnect + test | M |
| 6 | `applyConfig` restart theo command/url/env/headers | reconnect logic + test | M |

**Người chịu trách nhiệm:** MCP dev.

**Thời gian dự kiến:** 2.5 dev-days.

**Phụ thuộc:** 4.1 (protocol).

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| SSE parser vỡ với chunk lớn | Test chunk boundary; max body + backpressure |
| Reconnect loop vô hạn | Jitter + max attempts + health gate |

**File:** `src/mcp.ts`.

---

### 4.3. Tool governance

#### Mô tả & lý do

**Mô tả:** kiểm soát tool MCP được expose/cho phép theo cấu hình và annotations, tránh lạm dụng.

#### Công việc cụ thể

- Per-server config: `enabled`, `trust: "auto" | "ask" | "readonly"`, `tools.include/exclude`, `timeoutMs`, `maxOutputChars`.
- Dùng annotations: `readOnlyHint`, `destructiveHint` để quyết định permission mặc định.
- Lazy tool exposure: chỉ advertise top N hoặc thêm `mcp_search_tools` khi server có quá nhiều tool.
- Sanitize schema (`$ref`, `anyOf`) trước khi đưa LLM; validate args local.
- `structuredContent` → serialize vào tool result; image/audio content → TUI, không gửi LLM.
- Readonly mode: **không spawn** MCP server; nếu đã connected → ẩn tool + deny.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Per-server config mới (enabled/trust/tools/timeout/maxOutput) | config + validate | M |
| 2 | Permission theo annotations readOnly/destructive | policy + test | M |
| 3 | Lazy exposure + `mcp_search_tools` | exposure + test | M |
| 4 | Sanitize schema + validate args local | sanitizer + test | M |
| 5 | `structuredContent` serialize; media → TUI | result mapping | M |
| 6 | Readonly no-spawn + deny khi connected | gate + test | S |

**Người chịu trách nhiệm:** MCP dev + security review.

**Thời gian dự kiến:** 2 dev-days.

**Phụ thuộc:** 4.1–4.2.

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Server độc hại tự khai báo readonly | Coi `trust` là nguồn tin cậy, không coi hint |
| Tool quá nhiều làm loãng LLM | Lazy exposure + search tool |

---

### 4.4. Config & UX

#### Mô tả & lý do

**Mô tả:** trải nghiệm quản lý MCP qua CLI và TUI tốt hơn, import config từ hệ sinh thái khác.

#### Công việc cụ thể

- `scoder mcp add/list/test/restart/remove` (CLI).
- Import config từ `~/.claude.json`, `opencode.json`, `.mcp.json`.
- `/mcp` hiển thị latency, tool count, capabilities, last error.
- Sửa `mcpStatus` để server 0 tool vẫn `connected: true` (dựa trên connection, không dựa tools map).

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | CLI `scoder mcp add/list/test/restart/remove` | CLI + test | M |
| 2 | Import config từ claude/opencode/.mcp.json | importer + test | M |
| 3 | `/mcp` hiển thị latency/tool count/capabilities/error | TUI panel | M |
| 4 | Fix `mcpStatus` theo connection state | state fix + test | S |

**Người chịu trách nhiệm:** MCP dev + TUI dev (task 3).

**Thời gian dự kiến:** 1 dev-day.

**Phụ thuộc:** 4.1–4.3.

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Import trùng/thay đổi config user | Dry-run + confirm trước khi ghi |

---

### 4.5. Security

#### Mô tả & lý do

**Mô tả:** mặc định an toàn: output MCP là untrusted, secret được che, permission mặc định `ask`.

#### Công việc cụ thể

- Đánh dấu output MCP là **untrusted** trong prompt (chống prompt injection).
- Redact secrets; env allowlist; không shell interpolation.
- Per-server default permission `ask`; audit log tool call.
- OAuth cho HTTP MCP: để P2 (sau khi có nhu cầu thực tế).

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Untrusted wrapper trong prompt + test injection | prompt + test | M |
| 2 | Redact secret + env allowlist + no interpolation | sanitizer + test | M |
| 3 | Default `ask` + audit log | policy + log | M |
| 4 | Ghi chú OAuth P2 vào backlog (không làm) | note | S |

**Người chịu trách nhiệm:** MCP dev + security review bắt buộc.

**Thời gian dự kiến:** 1 dev-day.

**Phụ thuộc:** 4.3.

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Prompt injection qua output server | Untrusted wrapper + ngăn command từ output ngoài |
| Secret lộ trong transcript | Redact ở lớp ghi log/export |

---

### 4.6. Tests

#### Mô tả & lý do

**Mô tả:** mock server đủ dạng để phủ mọi nhánh protocol.

#### Công việc cụ thể

- Mock servers: stdio/http, resources/prompts, notifications, progress/cancel, reconnect, schema edge, 0-tool server, readonly no-spawn.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Mock stdio/http server helpers | fixtures | M |
| 2 | Mock resources/prompts/notifications | fixtures | M |
| 3 | Mock progress/cancel/reconnect | fixtures | M |
| 4 | Mock schema edge + 0-tool + readonly no-spawn | fixtures + test | M |

**Người chịu trách nhiệm:** MCP dev.

**Thời gian dự kiến:** 0.5 dev-day.

**Phụ thuộc:** toàn trụ 4.

**File:** `test/mcp/`.

---

## 5. Trụ 3 — Command & Skill

### 5.0. Tổng quan trụ Command/Skill

**Mô tả:** thống nhất command vào một registry, cho user tự định nghĩa command, nâng skills lên 2.0 với progressive disclosure, và hoàn thiện completion.

**Effort:** ~6 dev-days · **Phân bổ:** 5.1 (1.5d), 5.2 (2d), 5.3 (1.5d), 5.4 (0.5d), 5.5 (0.5d).

**Thứ tự làm:** 5.1 → 5.2 → 5.4 → 5.3 → 5.5.

**Người phụ trách:** UX/CLI dev + TUI dev (completion).

**Lưu ý phạm vi:** từ file gốc, "Unified `CommandDef` registry", "Skills 2.0" và "Completion v2" từng bị **deferred (scope trimmed)** — đánh dấu rõ trong checklist (mục 12) nếu chưa làm.

---

### 5.1. Một command registry duy nhất

#### Mô tả & lý do

**Mô tả:** bỏ tình trạng 2 danh sách command lệch nhau, mọi command khai báo một nơi duy nhất.

#### Công việc cụ thể

- Tạo `CommandDef`:

  ```ts
  { name, aliases, description, usage, argsSchema?, completion?, visibility, handler, source: "builtin" | "project" | "global" | "mcp" }
  ```

- Xoá danh sách trùng `SLASH_COMMANDS`; `/help` sinh từ registry.
- Chuyển `/review`, `/diff`, `/theme`, `/undo` từ `app.tsx` vào registry với `host` capability (`review()`, `diff()`, `theme()`, `snapshots()`).
- REPL, TUI, HTTP dùng cùng dispatch; command TUI-only có flag `tuiOnly`.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Định nghĩa `CommandDef` + registry | type + registry | M |
| 2 | Di dời 4 command vào registry với host capability | refactor + test | L |
| 3 | Một dispatch chung cho REPL/TUI/HTTP | dispatcher | M |
| 4 | `/help` sinh từ registry; xoá `SLASH_COMMANDS` | help + cleanup | M |

**Người chịu trách nhiệm:** UX/CLI dev + TUI dev.

**Thời gian dự kiến:** 1.5 dev-days.

**Phụ thuộc:** Phase 0 (registry skeleton).

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Refactor vỡ command TUI-only | Giữ flag `tuiOnly`; test PTY snapshot |
| Host capability phình | Tách interface nhỏ `CommandHost` |

**File:** `src/tui/commands.ts`, `src/tui/command-registry.ts`, `src/tui/app.tsx`, `src/index.ts`.

---

### 5.2. Custom commands

#### Mô tả & lý do

**Mô tả:** user tự thêm command chỉ bằng file `.md`, không cần sửa code.

#### Công việc cụ thể

- Discovery: `~/.scoder/commands/*.md` + `<workdir>/.scoder/commands/*.md`.
- Frontmatter:

  ```md
  ---
  description: Review the current diff
  agent: plan
  model: provider/model
  args: [path]
  ---
  Review @$1 and list blocking issues.
  ```

- Template: `$ARGUMENTS`, `$1..$n`, `@file`; shell `!` mặc định tắt.
- Execute modes: prompt (default), agent (subagent), shell (opt-in).
- Hot reload + `/commands reload`.
- `/commands` liệt kê command built-in + custom.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Discovery 2 thư mục + parse frontmatter | loader + test | M |
| 2 | Template engine `$1..$n`/`$ARGUMENTS`/`@file` | engine + test | M |
| 3 | Execute modes (prompt/agent/shell, shell opt-in) | runner + test | L |
| 4 | Hot reload + `/commands reload` | watcher + command | S |
| 5 | `/commands` listing built-in + custom | command | S |

**Người chịu trách nhiệm:** UX/CLI dev.

**Thời gian dự kiến:** 2 dev-days.

**Phụ thuộc:** 5.1 (registry) cho listing.

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Shell mode rủi ro bảo mật | Mặc định tắt; confirm rõ khi bật; hiển thị risk |
| Template lỗi syntax | Lint frontmatter + báo lỗi dòng cụ thể |

---

### 5.3. Skills 2.0

#### Mô tả & lý do

**Mô tả:** skills đọc dần theo nhu cầu (progressive disclosure) và `allowed-tools` được enforce thật.

#### Công việc cụ thể

- YAML parser hỗ trợ array/nested; thêm `version`, `tags`, `references`.
- Progressive disclosure: index → body → `references/*.md` theo yêu cầu; `load_skill` thêm `section`.
- `allowed-tools` **enforce thật**: filter tool specs trong turn skill active.
- `/skills info <name>`, `/skills lint`; cảnh báo trùng tên, thiếu description, tool không tồn tại.
- Auto-match scoring từ tags/description; model vẫn quyết định load.
- Tương thích thư mục skill kiểu Claude/opencode.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | YAML parser đầy đủ + field mới | parser + test | M |
| 2 | Progressive disclosure + `load_skill` section | loader + test | M |
| 3 | Enforce `allowed-tools` trong turn | filter + test | M |
| 4 | `/skills info` + `/skills lint` | command + lint | M |
| 5 | Auto-match scoring (tags/description) | scorer + test | S |
| 6 | Tương thích thư mục Claude/opencode | compat layer + test | M |

**Người chịu trách nhiệm:** UX/CLI dev.

**Thời gian dự kiến:** 1.5 dev-days.

**Phụ thuộc:** skill loader hiện tại (hot reload).

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Enforce nhầm chặn tool cần thiết | Whitelist theo turn chính xác; log khi chặn |
| Tương thích thư mục khác sai cấu trúc | Test với fixture Claude/opencode |

---

### 5.4. Command mới

#### Mô tả & lý do

**Mô tả:** bổ sung set command phủ năng lực mới, đồng bộ giữa REPL và TUI.

#### Công việc cụ thể

`/agent`, `/plan`, `/commands`, `/memory`, `/init` (tạo `AGENTS.md`), `/export`, `/search`, `/mcp add|test|restart`, `/skill info|reload`, `/undo` + `/diff` cho REPL.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | `/agent`, `/plan`, `/memory` | command + host | M |
| 2 | `/init` tạo `AGENTS.md` | command + template | S |
| 3 | `/export`, `/search` (TUI) | command | M |
| 4 | `/mcp add|test|restart`, `/skill info|reload` | command | M |
| 5 | `/undo` + `/diff` cho REPL | command | M |

**Người chịu trách nhiệm:** TUI dev + CLI dev.

**Thời gian dự kiến:** 0.5 dev-day (nhiều command nhỏ).

**Phụ thuộc:** 5.1 registry; 6.3 transcript (export/search).

---

### 5.5. Completion v2

#### Mô tả & lý do

**Mô tả:** completion thống nhất, async, fuzzy cho mọi registry.

#### Công việc cụ thể

- Provider registry: commands, skills, agents, files, MCP servers/tools/resources, sessions.
- Async có loading; fuzzy; mô tả; giới hạn kết quả; ranking.
- Tab behavior thống nhất; `/review` không hardcode language/server nữa.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Provider registry completion | provider + test | M |
| 2 | Async loading + fuzzy + limit + ranking | completion engine | M |
| 3 | Tab behavior thống nhất + bỏ hardcode `/review` | TUI | M |

**Người chịu trách nhiệm:** TUI dev.

**Thời gian dự kiến:** 0.5 dev-day.

**Phụ thuộc:** 5.1–5.3 (các provider).

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Completion chậm với nhiều provider | Async + caching + debounce |

---

## 6. Trụ 4 — TUI

### 6.0. Tổng quan trụ TUI

**Mô tả:** hiển thị đầy đủ event mới, command palette, transcript search/expand, accessibility & performance.

**Effort:** ~8 dev-days · **Phân bổ:** 6.1 (1d), 6.2 (1.5d), 6.3 (1.5d), 6.4 (1d), 6.5 (1d), 6.6 (1d), 6.7 (1d).

**Thứ tự làm:** 6.1 (nền tảng event) → 6.4 → 6.3 → 6.2 → 6.5 → 6.6 → 6.7.

**Người phụ trách:** TUI dev chuyên trách.

**Lưu ý phạm vi:** nhiều mục 6.2/6.3/6.5/6.6 trong file gốc từng bị **deferred (scope trimmed)** — đánh dấu rõ trong checklist mục 12.

---

### 6.1. Event coverage

#### Mô tả & lý do

**Mô tả:** reducer hiểu và render mọi event do Agent emit, không bỏ qua hay "unknown".

#### Công việc cụ thể

- Reducer xử lý `steer_queued`, `steer_delivered`, `compaction`, `agent_start/end`, `question_request`, `tool_progress`, `queue`.
- `toolPhase` thêm `grep`, `glob`, `task`, MCP.
- `run_start` mang `agent`, `schemaVersion`.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Reducer: các event mới (list ở trên) | state + reducer + test | L |
| 2 | `toolPhase` map mở rộng | state + test | S |
| 3 | `run_start` thêm `agent`/`schemaVersion` | schema + state | S |

**Người chịu trách nhiệm:** TUI dev.

**Thời gian dự kiến:** 1 dev-day.

**Phụ thuộc:** event schema (mục 7).

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Reducer lỡ nhánh event mới | Unit test từng event; cảnh báo "unknown" bị tắt chỉ khi đủ phủ |

---

### 6.2. Layout & navigation

#### Mô tả & lý do

**Mô tả:** điều hướng nhanh qua command palette và help overlay; responsive theo độ rộng màn hình.

#### Công việc cụ thể

- Command palette `Ctrl+P`: command, skill, agent, file, session.
- `?` mở help overlay; `/help` mở overlay thay vì dump vào chat.
- Responsive: 80/100/120 cols; sidebar auto-hide; section ưu tiên.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Command palette `Ctrl+P` (5 provider) | palette UI + host | L |
| 2 | Help overlay qua `?` và `/help` | overlay | M |
| 3 | Responsive breakpoints + sidebar auto-hide | layout + test | M |

**Người chịu trách nhiệm:** TUI dev.

**Thời gian dự kiến:** 1.5 dev-day.

**Phụ thuộc:** 5.5 completion (palette dùng chung provider).

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Palette phình nhiều provider | Limit + ranking; mở provider theo keyword |
| Layout vỡ ở 80 cols | PTY snapshot 80/100/120 |

---

### 6.3. Transcript

#### Mô tả & lý do

**Mô tả:** transcript xem/tìm/export/diff hiệu quả.

#### Công việc cụ thể

- Tool card collapsed 1 dòng; `Enter`/`o` expand, `c` copy item.
- `/search` hoặc `Ctrl+F`; `n/N` next/prev.
- `/export [md|json]`.
- Diff: syntax highlight, hunk navigation `[`/`]`, side-by-side khi đủ rộng.
- Subagent tree: indent, trạng thái, output gộp.
- Compaction divider + "đã tóm tắt N tin nhắn".
- Steering badge "queued/delivered".

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Tool card expand/collapse + copy | transcript item | M |
| 2 | `/search` + Ctrl+F + next/prev | search + state | M |
| 3 | `/export [md|json]` | export util | S |
| 4 | Diff syntax highlight + hunk nav + side-by-side | diff view | L |
| 5 | Subagent tree + compaction divider + steering badge | list view | M |

**Người chịu trách nhiệm:** TUI dev.

**Thời gian dự kiến:** 1.5 dev-day.

**Phụ thuộc:** 6.1 (event), event log (Phase 0).

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Transcript dài → lag | Virtual scroll + memoize markdown |

---

### 6.4. Status & sidebar

#### Mô tả & lý do

**Mô tả:** sidebar hiển thị trạng thái thật: context, cost, queue/steer, MCP, agent, plan.

#### Công việc cụ thể

- Context gauge + cost budget bar + queue/steer badge.
- MCP: latency, tool count, last error.
- Agent/model hiện tại; plan progress; adaptive sections (ẩn section rỗng).

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Context gauge + cost bar | widget | M |
| 2 | Queue/steer badge + MCP panel | widget | M |
| 3 | Agent/model + plan progress + adaptive sections | sidebar logic | M |

**Người chịu trách nhiệm:** TUI dev.

**Thời gian dự kiến:** 1 dev-day.

**Phụ thuộc:** 6.1 (context/queue event), 3.3 (plan).

---

### 6.5. Approval & ask

#### Mô tả & lý do

**Mô tả:** luồng xin phép và hỏi user rõ ràng, an toàn.

#### Công việc cụ thể

- Permission queue: hiện số request đang chờ; modal scroll diff.
- `ask_user` modal: single/multi choice + free text.
- Hiển thị risk level cho command nguy hiểm.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Permission queue + modal scroll diff | modal | M |
| 2 | `ask_user` modal (single/multi/free) | modal + host | M |
| 3 | Risk level cho command nguy hiểm | widget | S |

**Người chịu trách nhiệm:** TUI dev.

**Thời gian dự kiến:** 1 dev-day.

**Phụ thuộc:** 3.6 (`ask_user` tool), 4.3 (permission MCP).

---

### 6.6. Accessibility & performance

#### Mô tả & lý do

**Mô tả:** dùng được cho screen-reader và chạy mượt với transcript dài.

#### Công việc cụ thể

- `NO_COLOR`, `--no-motion`, `--plain` (screen-reader), ASCII fallback, high-contrast theme.
- Thay `estimateItemRows` heuristic bằng đo thật + cache; memoize markdown; frame budget 50ms.
- Test 10k event scroll không lag.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | `NO_COLOR`/`--no-motion`/`--plain`/ASCII/high-contrast | flags + themes | M |
| 2 | Đo height thật + cache; memoize markdown | perf core | L |
| 3 | Frame budget 50ms + test 10k scroll | perf test | M |

**Người chịu trách nhiệm:** TUI dev + a11y review.

**Thời gian dự kiến:** 1 dev-day.

**Phụ thuộc:** 6.3 (virtual scroll).

**Rủi ro & giảm thiểu:**

| Rủi ro | Giảm thiểu |
|---|---|
| Tối ưu phá layout | Benchmark trước/sau; giữ fallback heuristic cho trường lạ |

---

### 6.7. Tests

#### Mô tả & lý do

**Mô tả:** test unit + PTY snapshot + perf để giữ TUI ổn định.

#### Công việc cụ thể

- Reducer unit cho mọi event mới.
- PTY snapshot (`test/pty-run.py`) cho layout 80/100/120 cols.
- Perf test stream dài.

#### Chi tiết task phụ

| # | Task | Đầu ra | Cỡ |
|---|---|---|---|
| 1 | Reducer unit tests đầy đủ | tests | M |
| 2 | PTY snapshot 80/100/120 | snapshot + CI | M |
| 3 | Perf test stream dài | bench | M |

**Người chịu trách nhiệm:** TUI dev.

**Thời gian dự kiến:** 1 dev-day.

**Phụ thuộc:** toàn trụ 6.

---

## 7. Thay đổi schema

### 7.1. AgentEvent mới (additive) — giữ nguyên định nghĩa từ file gốc

```ts
| { type: "compaction"; tokensBefore: number; tokensAfter: number; manual?: boolean }
| { type: "agent_start"; id: string; parentId?: string; name: string; description: string; model: string }
| { type: "agent_end"; id: string; ok: boolean; steps: number; summary: string }
| { type: "tool_progress"; id: string; name: string; current?: number; total?: number; message?: string }
| { type: "question_request"; id: string; question: string; options?: string[]; multiple?: boolean; timeoutSecs: number }
| { type: "queue"; pending: number; steering: number }
| { type: "context"; tokens: number; window: number; pct: number; compacted?: boolean }
```

`run_start` thêm `schemaVersion`, `agent`; `finish` thêm `usage`, `verification`.

#### Chi tiết mở rộng

| Event | Người emit | Người render | Ghi chú |
|---|---|---|---|
| `compaction` | compaction (3.4) | transcript divider (6.3) | `manual` khi user `/compact` |
| `agent_start/end` | `task` tool (3.6) | subagent tree (6.3) | `parentId` cho cây lồng |
| `tool_progress` | tools dài hạn (MCP 4) | tool card progress bar | dùng cho progress/cancel |
| `question_request` | `ask_user` (3.6) | ask modal (6.5) | `timeoutSecs` hết hạn thì cancel |
| `queue` | agent core | sidebar badge (6.4) | pending + steering |
| `context` | context injector (3.2/3.4) | context gauge (6.4) | `compacted` đánh dấu đã cắt |

**Ràng buộc:** mọi event mới phải **additive** (optional field); parser event cũ phải bỏ qua field lạ mà không vỡ. Kèm migration test.

### 7.2. Config mới — giữ nguyên định nghĩa từ file gốc

```jsonc
{
  "agent": "build",
  "routing": { "plan": "provider/model", "build": "provider/model", "review": "provider/model" },
  "commands": { "enabled": true },
  "skills": { "autoLoad": true },
  "mcpServers": {
    "x": { "enabled": true, "trust": "ask", "timeoutMs": 120000, "tools": { "include": [], "exclude": [] } }
  },
  "tui": { "notifications": true, "motion": "full" }
}
```

#### Chi tiết mở rộng — nguồn gốc của từng field

| Field | Trụ/mục | Ý nghĩa |
|---|---|---|
| `agent` | 3.1 | agent primary mặc định |
| `routing` | 3.7 | model theo phase plan/build/review |
| `commands.enabled` | 5 | bật/tắt custom command |
| `skills.autoLoad` | 5.3 | auto-match load skill |
| `mcpServers.<x>.enabled/trust/timeoutMs/tools` | 4.3 | governance per-server |
| `tui.notifications/motion` | 6.6 | trải nghiệm TUI |

**Ràng buộc:** config cũ vẫn chạy (field thiếu → default); alias cho field cũ nếu đổi tên. Có migration test (xem mục 9).

---

## 8. Roadmap & estimates

### 8.1. Bảng roadmap (giữ nguyên từ file gốc)

| Phase | Nội dung | Effort | Phụ thuộc |
|---|---|---|---|
| 0 | Foundations: event schema, command registry skeleton, eval harness | 3d | — |
| 1 | Agent A: profiles/routing + repo map + AGENTS.md + prompt V5 | 7d | Phase 0 |
| 2 | Agent B: planning 2.0 + memory + compaction v2 | 6d | Phase 1 |
| 3 | Agent C: diagnostics + verification + delegation + eval gate | 7d | Phase 2 |
| 4 | MCP A: protocol completeness + streaming + cancellation | 5d | Phase 0 |
| 5 | MCP B: governance + import/CLI + security + tests | 4d | Phase 4 |
| 6 | Command/Skill: registry, custom command, skills 2.0, completion | 6d | Phase 0 |
| 7 | TUI: event coverage, palette, transcript, a11y, perf | 8d | Phase 0, 6 |
| 8 | Hardening: docs, migration, changelog, release | 3d | tất cả |

**Tổng: ~49 dev-days.** 1 dev ≈ 9–10 tuần; 2 devs ≈ 5 tuần (Agent và MCP/Command chạy song song sau Phase 0).

### 8.2. Chi tiết phase → mục ánh xạ

| Phase | Map mục trong file này | Cổng ra (gate) |
|---|---|---|
| 0 | mục 7 (schema), 5.1 skeleton, 3.8 (dựng), 8.4 | typecheck + lint xanh; eval chạy được |
| 1 | 3.1, 3.2, 3.7 | eval "tìm symbol" ≤2 calls; `--agent plan` read-only |
| 2 | 3.3, 3.4 | resume compaction 8/10; plan có verify/acceptance |
| 3 | 3.5, 3.6, 3.8 (CI gate) | seeded bug fix; diagnostics structured; CI gate bật |
| 4 | 4.1, 4.2 (phần A) | SSE incremental; cancel; protocol resources/prompts |
| 5 | 4.3 (danh mục), 4.4, 4.5, 4.6 | readonly no-spawn; CLI mcp; security review pass |
| 6 | 5.1, 5.2, 5.3, 5.4, 5.5 | custom command bằng file md; `/help` từ registry |
| 7 | 6.1–6.7 | event mới render; PTY snapshot pass; 10k scroll ok |
| 8 | mục 9 (DoD) + docs | typecheck/lint/test xanh; migration test pass |

### 8.3. Chi tiết kế hoạch 2 dev (song song)

| Tuần | Dev A (Agent) | Dev B (MCP + Command/Skill) |
|---|---|---|
| 1 | Phase 0 (schema, eval baseline) | Phase 0 (registry skeleton) |
| 2–3 | Phase 1 (profiles, repo map, V5) | Phase 4 (MCP A) |
| 4–5 | Phase 2 (planning, memory, compaction) | Phase 5 (MCP B) + bắt đầu 6 |
| 6–7 | Phase 3 (diagnostics, verify, delegation) | Phase 6 (Command/Skill) |
| 8 | Joint Phase 7 (TUI) | Joint Phase 7 (TUI) |
| 9–10 | Phase 8 hardening | Phase 8 hardening |

---

## 9. Acceptance criteria & Definition of Done

### 9.1. Theo trụ (giữ nguyên ý từ file gốc)

**Agent**

- Eval suite ≥20 scenarios; success rate tăng ≥15%; median steps giảm ≥20%; false-done = 0.
- `--agent plan` không ghi file; `ask_user` hoạt động ở TUI/REPL.
- Resume sau compaction trả lời đúng 8/10 câu hỏi memory.

**MCP**

- Mock suite ≥10 server; first-call success ≥98%; reconnect <10s; không orphan process.
- Readonly không spawn server; `structuredContent` đến được LLM; SSE không buffer toàn bộ.

**Command/Skill**

- Thêm custom command chỉ cần file `.md`, không sửa code.
- `/help` và completion sinh từ một registry; không còn danh sách trùng.
- Skill `allowed-tools` được enforce; lint bắt lỗi metadata.

**TUI**

- Mọi event mới render; không còn cảnh báo "unknown".
- 80 cols usable; 10k event scroll không lag; PTY snapshot pass.

**Chung**

- `npm run typecheck`, `npm run lint`, `npm test` xanh.
- Docs cập nhật: `README.md`, `docs/mcp.md`, `docs/skills.md`, `docs/commands.md`, `docs/tui.md`, `CHANGELOG.md`.
- Không phá session cũ; config cũ vẫn chạy.

### 9.2. Definition of Done chi tiết (mức task)

Một task được coi là DONE khi:
1. Code + unit test cover nhánh chính và nhánh lỗi.
2. Chạy được với cấu hình cũ (backward-compatible) nếu có đổi schema.
3. Có mục nhập trong checklist phase tương ứng.
4. (Task Agent) eval trước/sau không regression >5%.
5. (Task TUI) PTY snapshot/perf test không fail.
6. Tài liệu/CHANGELOG cập nhật nếu thay đổi hành vi.

---

## 10. Rủi ro & rollback

### 10.1. Bảng rủi ro (giữ nguyên từ file gốc)

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Prompt V5 regress | Cao | Eval gate + feature flag `promptVersion`; rollback về V4 |
| Context bloat (repo map/memory) | Cao | Hard token budget; đo trước/sau; tắt từng phần bằng config |
| MCP third-party độc hại | Cao | Trust level, default ask, readonly no-spawn, redact, untrusted wrapper |
| TUI phình + chậm | TB | Frame budget, measured heights, PTY perf test |
| Scope creep | Cao | Phase gate; out-of-scope list |
| Backward compat | TB | Event/config additive; migration test |

### 10.2. Chi tiết giảm thiểu cho từng rủi ro cao

| Rủi ro | Plan A (giảm thiểu) | Plan B (rollback) |
|---|---|---|
| Prompt V5 regress | `PROMPT_VERSION=4` feature flag; eval gate chặn regression >5% | Set `PROMPT_VERSION=4` trong config; revert PR |
| Context bloat | Budget cứng (memory ≤1.5k, repo map ≤2k); measure trước/sau | Tắt `repoMap`/`memory` trong config; kích hoạt lại sau |
| MCP third-party độc hại | Trust level `ask` mặc định; readonly no-spawn; untrusted wrapper; redact | Xoá server khỏi config; `trust: deny` |
| Scope creep | Phase gate (cổng review trước khi bắt đầu phase mới); out-of-scope list trong mỗi phase | Phản hồi user rõ ràng; tạo issue mới thay vì nhét vào phase |

### 10.3. Out of scope cố định (từ file gốc)

> web UI, cloud sync, full LSP server, vector DB/embeddings, MCP OAuth, multi-tenant auth.

**Lý do:** không có user request; mỗi mục cần ít nhất 2–4 tuần dev; ảnh hưởng không tương xứng với scope v0.9→1.0.

### 10.4. ADR yêu cầu cho thay đổi lớn

Bất kỳ thay đổi nào sau đây đều phải có ADR (Architecture Decision Record) trước khi implement:

| Trigger | ADR yêu cầu |
|---|---|
| Thêm runtime dependency mới | Dependency ADR: tại sao, alternatives, risk |
| Thay đổi event/schema breaking | Schema ADR: migration path, backward compat plan |
| Thêm feature flag permanent | Flag ADR: cleanup plan, deadline |
| Thay đổi prompt phiên bản | Prompt ADR: A/B results, rollback plan |

---

## 11. Quick wins (làm ngay trong 1–2 ngày)

> Các task bên dưới **không** nằm trong effort estimate chính. Thực hiện khi cần momentum đầu sprint hoặc cần kết quả sớm.

### 11.1. Danh sách quick wins (giữ nguyên từ file gốc, bổ sung chi tiết)

| # | Quick win | Đầu ra | Cỡ | Ghi chú |
|---|---|---|---|---|
| 1 | `read_file` thêm `offset/limit` | tool schema | 1d | 3.2 foundation |
| 2 | Inject `AGENTS.md` + `/init` tạo template | context + command | 0.5d | 3.2 foundation |
| 3 | `--agent` + `/agent` cơ bản | CLI + command | 0.5d | 3.1 foundation |
| 4 | MCP readonly không spawn | gate | 0.5d | 4.3 foundation |
| 5 | `structuredContent` pass-through | result mapping | 0.5d | 4.3 foundation |
| 6 | Fix `mcpStatus` 0-tool | state | 0.5d | 4.4 foundation |
| 7 | TUI reducer xử lý `steer_queued/delivered` + compaction event | reducer | 0.5d | 6.1 foundation |
| 8 | Sinh `/help` từ registry; bỏ hardcode `/review` | help + registry | 0.5d | 5.1 foundation |
| 9 | Sửa `timeout_secs` schema thành number | schema + migration | 0.25d | 3.6 foundation |
| 10 | `/export` transcript | command | 0.5d | 6.3 foundation |
| 11 | `ask_user` skeleton + modal | tool + modal | 0.5d | 3.6 + 6.5 |
| 12 | Eval baseline: chạy 10 scenario, lưu JSON | harness | 0.5d | 3.8 foundation |

**Tổng quick wins:** ~6 dev-days (làm lẻ tẻ hoặc gom 2 ngày đầu sprint).

### 11.2. Thứ tự ưu tiên quick wins

| Thứ tự | Win | Lý do |
|---|---|---|
| 1 | Eval baseline | Nền tảng đo lường mọi thay đổi |
| 2 | MCP readonly no-spawn | Security cao, effort thấp |
| 3 | `read_file` range | Ảnh hưởng hàng ngày của mọi dev |
| 4 | `/help` từ registry | Giảm confusion ngay |
| 5 | TUI reducer event mới | Người dùng thấy thay đổi |

---

## 12. Checklist theo phase

> **Giữ nguyên trạng thái `[x]`/`[ ]` từ `next-plan.md`.** Chỉ thêm/sub `[ ]` khi có commit/merge tương ứng.

- [x] Phase 0 — Foundations
  - [x] Chốt event schema v2 (additive)
  - [x] Tạo command registry skeleton
  - [x] Dựng eval harness + baseline 10 scenario
- [x] Phase 1 — Agent A
  - [x] AgentDef mở rộng + `--agent` + `/agent`
  - [x] `AGENTS.md` hierarchy + `/init`
  - [x] Repo map + `read_file` range + `grep` context
  - [x] Prompt V5 + version log
- [x] Phase 2 — Agent B
  - [x] `write_todos` 2.0 (verify/acceptance/depends_on)
  - [x] `src/memory.ts` + inject ledger
  - [x] Compaction v2 + resume test
- [x] Phase 3 — Agent C
  - [x] Diagnostics parser + verify commands
  - [x] Self-review pass + completion gate
  - [x] `ask_user` (tool contract + event + timeout)
  - [x] `task` batch + edit fuzzy/apply_patch
  - [x] Eval gate CI
- [ ] Phase 4 — MCP A
  - [x] Protocol version + capabilities + instructions (from initialize)
  - [x] `tools/list_changed` notification → reregisterTools
  - [x] HTTP SSE incremental + consumeSseStream (ReadableStream, no body buffer)
  - [x] AbortSignal cancellation (combined in HttpTransport.post, wire only)
  - [x] Per-server tool filters (tools.include/exclude + glob)
  - [x] applyConfig restart on transport-effective config change
  - [x] `mcpStatus`/`serverStates` using connection state (not tool count)
  - [x] Resources/prompts/notifications (full list + read/subscribe)
  - [x] Eval gate CI
- [x] Phase 5 — MCP B
  - [x] Per-server trust/enabled config (enabled, trust: auto/ask/readonly/deny)
  - [x] Readonly no-spawn (trust:readonly → skip, state=disabled)
  - [x] `scoder mcp` CLI (list/add/remove/test + config read/write)
  - [ ] Config import from ~/.claude.json, opencode.json, .mcp.json
  - [ ] Audit log tool call + untrusted output flag
  - [ ] Eval gate CI
- [ ] Phase 6 — Command/Skill MVP
  - [x] Custom `.scoder/commands/*.md` (global + project, YAML frontmatter, $1/$ARGUMENTS)
  - [x] `/commands` listing + inspect
  - [ ] Unified `CommandDef` registry (deferred — scope trimmed)
  - [ ] Skills 2.0 (progressive disclosure + enforce allowed-tools) (deferred)
  - [ ] Completion v2 (deferred)
- [x] Phase 7 — TUI (transcript features)
  - [x] SubagentSection in sidebar (running/ok/failed + summary)
  - [x] `/export [md|json]` — exports transcript to workdir/scoder-export.{md|json}
  - [x] `/search <query>` — searches transcript, shows snippets + TUI scroll-to-item
  - [x] Transcript helpers (transcript.ts): exportTranscript, findInTranscript, copyTextForItem
  - [x] toolPhase: mcp__* → "mcp", repo_map → "explore", ask_user → "clear", task → "delegate"
  - [x] CommandHost transcriptItems + selectTranscriptItem (TUI host)
  - [ ] Reducer event coverage for steer_queued/steer_delivered/compaction/agent_start/end/tool_progress (already covered in existing state.ts)
  - [ ] Command palette / help overlay / diff nav / subagent tree (deferred — scope trimmed)
  - [ ] Permission queue / ask_user modal / risk level (deferred)
  - [ ] NO_COLOR / --no-motion / --plain / high-contrast (deferred)
- [x] Phase 8 — Hardening
  - [x] Docs + CHANGELOG [0.9.0] section
  - [x] Migration/backward-compat test (9 tests: config + event + skill)
  - [x] Release 0.9.0 (package.json version bump)

---

## Phụ lục

### A. ADR Index (Architecture Decision Records)

Các ADR phải được tạo cho mỗi quyết định lớn. Vị trí: `docs/adr/`.

| ADR # | Chủ đề | Trạng thái | Phase liên quan |
|---|---|---|---|
| ADR-001 | Event-first design principle | accepted | Phase 0 |
| ADR-002 | Additive event/config (no breaking) | accepted | Phase 0 |
| ADR-003 | Token budget cho context/memory/repo-map | draft | Phase 1–3 |
| ADR-004 | MCP trust level default `ask` | draft | Phase 4–5 |

### B. Glossary

| Thuật ngữ | Định nghĩa |
|---|---|
| **Compaction** | Nén lịch sử chat để giảm context window |
| **Eval harness** | Bộ đo lường tự động chạy kịch bản để đánh giá agent |
| **False-done** | Agent kết thúc mà không hoàn thành task thực sự |
| **Ledger** | Bản ghi quyết định/hành động trong working memory |
| **Progressive disclosure** | Load skill theo từng phần: index → body → references |
| **Replan rule** | Bắt buộc cập nhật plan khi có verify-fail hoặc file mới |
| **Structured content** | Dữ liệu có cấu trúc (image/text/artifact) từ MCP tool |
| **Untrusted wrapper** | Đánh dấu output từ nguồn ngoài là untrusted trong prompt |

### C. File & folder convention

| Pattern | Ý nghĩa |
|---|---|
| `src/**/*.ts` | Source TypeScript (module, không React) |
| `src/tui/**/*.tsx` | React components cho TUI |
| `test/*.test.mjs` | Node.js test (ESM) |
| `test/mcp/*.mjs` | MCP mock server tests |
| `test/eval/scenarios/*.json` | Eval scenario definitions |
| `docs/adr/*.md` | Architecture Decision Records |
| `.scoder/commands/*.md` | User-defined custom commands |
| `~/.scoder/AGENTS.md` | Global agent instructions (user config) |
| `AGENTS.md` | Project-level agent instructions |

---

> **Kết thúc file.** File này mở rộng chi tiết từ `next-plan.md`. Mọi mục `[ ]` chưa done cần có PR tương ứng trước khi đánh `[x]`. Mọi mục `[~]` cần được khôi phục khi có đủ effort/ưu tiên.
