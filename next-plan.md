# Next Plan — scoder 0.9 → 1.0

> Trạng thái: draft · Baseline: 0.8.21 · Cập nhật: 2026-11-05
> Thứ tự ưu tiên: Agent → MCP → Command/Skill → TUI

## 0. Tóm tắt điều hành

Bốn trụ nâng cấp:

| Trụ | Mục tiêu | Ưu tiên | Effort |
|---|---|---|---|
| **Agent intelligence** | Agent tự hiểu repo, lập kế hoạch tốt hơn, tự kiểm chứng, tự sửa, biết hỏi user, biết delegate | **P0 — quan trọng nhất** | ~20 dev-days |
| **MCP** | Đủ protocol (resources/prompts/notifications), streaming thật, governance + bảo mật | P1 | ~9 dev-days |
| **Command/Skill** | Một registry duy nhất, custom command, skill 2.0, completion thống nhất | P1 | ~6 dev-days |
| **TUI** | Hiển thị đầy đủ event mới, command palette, transcript search/expand, a11y | P1 | ~8 dev-days |
| **Hardening** | Eval gate, docs, migration, release | P0 | ~3 dev-days |

**Kết quả kỳ vọng:** task success rate +15–25% trên eval suite; median steps −20%; false-done rate = 0; MCP first-call success ≥98%; TUI không rớt frame khi stream.

---

## 1. Baseline & khoảng trống đã xác nhận

| Khu vực | Đang có | Thiếu / vấn đề |
|---|---|---|
| **Agent** | Closed-loop, guardrails, compaction, subagent `task`, steering, snapshots, 3 built-in agent | Prompt tĩnh; không có `AGENTS.md`; không chọn primary agent; không có repo map/symbol index; `read_file` đọc cả file; plan chỉ là todo list; verify chỉ build; không có self-review; memory sau compaction mất cấu trúc |
| **MCP** | stdio + HTTP, reconnect, schema validate, hot reload, permission cho `mcp__*` | Chỉ `tools/*`; không resources/prompts/notifications; HTTP đọc `res.text()` (buffer cả SSE); không progress/cancel; `structuredContent` bị bỏ; readonly vẫn spawn server; `applyConfig` không restart server khi config đổi; prompt chỉ liệt kê tên server |
| **Command/Skill** | `/help`, `/compact`, `/mcp`, `/skill`…; skill frontmatter đơn giản; hot reload skills | 2 danh sách command dễ lệch (`tui/commands.ts` vs `tui/command-registry.ts`); TUI hardcode `/review`, `/diff`, `/theme`, `/undo`; không custom command; skill không progressive disclosure; `allowed-tools` chỉ để hiển thị |
| **TUI** | Mission Control, sidebar, virtual scroll, diff card, image, vim, mouse wheel, theme | Reducer bỏ qua `steer_queued`/`steer_delivered`; không có event compaction/subagent; tool card không expand/collapse; không search/copy/export; `/review` hardcode server `prompt-gate` + `language: "vietnamese"`; height estimate là heuristic |

---

## 2. Nguyên tắc triển khai

1. **Event-first:** mọi năng lực mới phải đi qua `AgentEvent` để REPL, TUI, `serve` cùng thấy.
2. **Một registry:** tool, command, skill, agent đều có metadata + handler + completion chung.
3. **Additive & backward-compatible:** event/config thêm field, không phá schema cũ; feature flag cho thay đổi lớn.
4. **Đo được:** mỗi thay đổi Agent phải có eval trước/sau; không merge nếu regression >5%.
5. **Security by default:** MCP readonly không spawn; tool lạ mặc định `ask`; output ngoài được đánh dấu untrusted.
6. **Không thêm runtime dependency nếu không cần:** ưu tiên tree-sitter có sẵn, `fetch`, `node:*`; dependency mới phải có ADR.

---

## 3. Trụ 1 — Agent intelligence (P0, làm trước)

### 3.1. Agent profiles & routing

**Mục tiêu:** biến `AgentDef` từ "prompt cho subagent" thành **agent hạng nhất** chọn được, có model/tool/permission riêng.

Việc làm:
- Mở rộng `AgentDef`: `tools?: string[]`, `permission?: PermissionMode`, `temperature?`, `reasoning?`, `maxTokens?`, `skills?: string[]`, `color?`.
- Thêm `config.agent` + CLI `--agent <name>`; TUI `/agent [name]` mở picker.
- Chỉ cho chọn agent `mode: primary | all`; `subagent` chỉ dùng qua `task`.
- Agent `plan` phải **read-only ở tầng tool**, không chỉ permission: filter `allToolSpecs()` bỏ `write_file`, `edit_file`, `run_command` mutating.
- Per-agent model: `plan` dùng model rẻ; `build` model mạnh; `review` model rẻ/khác provider.
- Khi đổi agent giữa session: nếu đang chạy → chặn; nếu idle → reset system prompt + tool list, giữ history (hoặc fork session nếu user muốn).

**File chính:** `src/agents.ts`, `src/config.ts`, `src/agent.ts`, `src/index.ts`, `src/tui/command-registry.ts`.

**Acceptance:**
- `scoder --agent plan "..."` không bao giờ ghi file.
- `/agent` liệt kê đúng primary agents, đổi được khi idle.
- Subagent kế thừa đúng tool filter + model + `allowSubagents:false`.

---

### 3.2. Repo understanding & context assembly

**Mục tiêu:** giảm số lần đọc file mò, đưa đúng context ngay từ đầu.

Việc làm:
- **`AGENTS.md` hierarchy:** `~/.scoder/AGENTS.md` → `<workdir>/AGENTS.md` → `AGENTS.md` gần file đang sửa. Inject phần liên quan, không nuốt toàn bộ.
- **Repo map:** file tree + symbol outline (tree-sitter cho TS/JS nếu grammar có; fallback regex cho Python/Go/Rust). Cache theo mtime, budget ~2–4k tokens.
- **Context pack:** chọn file theo task keywords + symbol hits + recent edits + test files; không inject cả repo.
- Nâng `read_file`: `offset`, `limit`, `max_lines`; trả line range thay vì cả file.
- Nâng `grep`: `context_before/after`, `max_results`, `type`, đường dẫn tương đối.
- Nâng `list_files`: `depth`, `exclude`, `include_hidden`.
- Thêm tool `repo_map` hoặc inject bản rút gọn vào system prompt.
- Cache + dedupe tool result theo `(tool, args, mtime)`; invalidate khi write/edit.

**File chính:** `src/context.ts`, `src/tools.ts`, `src/prompt-builder.ts`, new `src/repo-map.ts`.

**Acceptance:**
- Trên eval "tìm symbol X", agent đạt kết quả trong ≤2 tool calls thay vì đọc 5–10 file.
- Repo map không làm system prompt vượt budget đã định.

---

### 3.3. Planning 2.0

**Mục tiêu:** plan có **acceptance + verification**, không chỉ checklist.

Việc làm:
- Mở rộng schema `write_todos`:
  ```ts
  { id, content, status, verify?: string, depends_on?: string[], files?: string[], acceptance?: string }
  ```
- Bắt buộc plan trước edit với task multi-step: guardrail mềm inject nhắc nếu chưa có plan.
- Chỉ 1 `in_progress`; plan update phải kèm lý do nếu đổi thứ tự.
- Lưu plan vào session v2; resume khôi phục.
- `/plan` để xem, sửa, mark step; sidebar hiển thị đúng thứ tự và trạng thái.
- Replan rule: sau 2 lần verify fail hoặc phát hiện file mới → bắt buộc cập nhật plan.

**File chính:** `src/tools.ts` (`write_todos`), `src/agent.ts`, `src/guardrails.ts`, `src/tui/state.ts`, `src/tui/sidebar.tsx`.

**Acceptance:**
- Plan hiển thị đầy đủ verify/acceptance trong TUI.
- Task multi-file có plan trước lần edit đầu tiên.

---

### 3.4. Memory & compaction 2.0

**Mục tiêu:** không mất quyết định/bối cảnh sau compaction hoặc resume.

Việc làm:
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

**File chính:** new `src/memory.ts`, `src/compaction.ts`, `src/agent.ts`, `src/session.ts`.

**Acceptance:**
- Resume sau compaction trả lời đúng "đã sửa file nào / quyết định gì / lỗi nào".
- Eval compaction: 10 câu hỏi về history cũ, đúng ≥8/10.

---

### 3.5. Verification & self-correction

**Mục tiêu:** agent không "nói xong" khi chưa kiểm chứng; tự sửa lỗi thay vì lặp.

Việc làm:
- `src/diagnostics.ts`: parse `tsc`, `eslint`, `pytest`, `go test`, `cargo` → `{file,line,severity,code,message}`.
- Detect verify commands: build + test + lint/typecheck từ `package.json`, `pyproject.toml`, `Cargo.toml`, `Makefile`; config `verifyCmds`.
- Completion gate: build + test (nếu có) + không còn diagnostic blocking; `completion-claim` dùng kết quả verify, không dùng text.
- Self-review pass: sau edit, trước finish, chạy review trên diff + acceptance; nếu fail → inject findings.
- Error classifier: syntax/type/test/runtime/permission/network → chiến lược (đọc thêm, sửa, retry, hỏi user, dừng).
- Guardrail `no-progress`: không đổi file + cùng lỗi + token burn → đổi hướng hoặc dừng.

**File chính:** new `src/diagnostics.ts`, `src/build.ts`, `src/guardrails.ts`, `src/agent.ts`, `src/tools.ts`.

**Acceptance:**
- Eval seeded bug: fix trong ≤N bước, không false-done.
- Khi build fail, agent nhận structured diagnostics thay vì raw log.

---

### 3.6. Delegation & tool intelligence

Việc làm:
- `task` tool: hỗ trợ batch `tasks: [...]`, chạy bounded concurrency, merge kết quả; emit `agent_start/agent_end`.
- Auto chọn agent: explore cho tìm kiếm, review cho diff, plan cho thiết kế; validate agent tồn tại.
- Hiển thị `description` của subagent trong TUI (hiện chỉ có tag).
- Thêm `ask_user` tool: `{question, options?, multiple?, timeoutSecs?}`; TUI modal, REPL prompt, server trả lỗi rõ nếu không interactive.
- `edit_file`: fuzzy fallback (chuẩn hóa whitespace) + báo lỗi gần đúng; thêm `apply_patch` cho multi-hunk.
- `read_file` range; `write_file` atomic; `run_command` trả exit code/duration có cấu trúc.
- Sửa schema `timeout_secs` từ `string` → `number` cho đúng handler.

**File chính:** `src/tools.ts`, `src/agent.ts`, `src/tui/state.ts`.

**Acceptance:**
- 2 subagent chạy song song không giẫm event/message.
- `ask_user` hoạt động ở TUI + REPL; server trả `409`/`not-interactive`.

---

### 3.7. Prompt V5 & model strategy

Việc làm:
- Tách prompt thành các section có ID + budget: identity, workflow, tool policy, safety, scope, verification, memory, skills, MCP, output.
- Thêm decision policy: khi nào plan, khi nào hỏi, khi nào dừng, ngôn ngữ trả lời theo user.
- Thêm anti-hallucination: không bịa API/path; phải verify bằng tool.
- `PROMPT_VERSION = 5`; log version vào session; A/B bằng eval.
- Model routing: `routing: { plan, build, review }`; fallback provider khi lỗi; cost/token budget theo phase.

**File chính:** `src/prompt.ts`, `src/prompt-builder.ts`, `src/config.ts`, `src/agent.ts`, `src/provider-registry.ts`.

**Acceptance:**
- Eval V5 ≥ V4 trên success rate; không tăng median tokens quá 10%.
- Đổi `routing` không cần sửa code.

---

### 3.8. Eval harness

Việc làm:
- `test/eval/scenarios/*.json`: bugfix, feature, refactor, test-failure, multi-file, MCP, permission.
- Metrics: success, steps, tokens, tool calls, error recovery, wall time, false-done.
- Mock LLM cho deterministic; nightly real-model eval; lưu JSONL.
- CI gate: regression >5% → fail; so sánh prompt version.

**File chính:** `test/run-eval.mjs`, `test/eval/`.

---

## 4. Trụ 2 — MCP

### 4.1. Protocol completeness
- Negotiate `protocolVersion` (hỗ trợ 2024-11-05 + bản mới), lưu `serverInfo`, `instructions`, `capabilities`.
- Resources: `resources/list`, `resources/templates/list`, `resources/read`, `resources/subscribe`; expose tool `mcp__<server>__read_resource` hoặc tích hợp `@resource`.
- Prompts: `prompts/list`, `prompts/get`; expose qua `/mcp prompt` hoặc tool.
- Notifications: `tools/list_changed`, `resources/list_changed`, `resources/updated`, `message`, `progress`.
- Health: dùng `ping` thay vì `tools/list` làm liveness probe; latency metric.

**File:** `src/mcp.ts`, `src/agent.ts`, `src/tui/command-registry.ts`.

### 4.2. Transport hardening
- HTTP: parse SSE **incremental** thay vì `res.text()`; hỗ trợ GET stream cho server→client; xử lý session expiry; idle timeout per chunk; max body.
- Cancellation: `AbortSignal` → gửi `notifications/cancelled`; reject pending đúng cách.
- Reconnect: giữ backoff; thêm jitter; health check định kỳ; kill orphan process.
- `applyConfig`: restart server khi command/url/env/headers đổi, không chỉ add/remove.

**File:** `src/mcp.ts`.

### 4.3. Tool governance
- Per-server config: `enabled`, `trust: "auto" | "ask" | "readonly"`, `tools.include/exclude`, `timeoutMs`, `maxOutputChars`.
- Dùng annotations: `readOnlyHint`, `destructiveHint` để quyết định permission mặc định.
- Lazy tool exposure: chỉ advertise top N hoặc thêm `mcp_search_tools` khi server có quá nhiều tool.
- Sanitize schema (`$ref`, `anyOf`) trước khi đưa LLM; validate args local.
- `structuredContent` → serialize vào tool result; image/audio content → TUI, không gửi LLM.
- Readonly mode: **không spawn** MCP server; nếu đã connected → ẩn tool + deny.

### 4.4. Config & UX
- `scoder mcp add/list/test/restart/remove` (CLI).
- Import config từ `~/.claude.json`, `opencode.json`, `.mcp.json`.
- `/mcp` hiển thị latency, tool count, capabilities, last error.
- Sửa `mcpStatus` để server 0 tool vẫn `connected: true` (dựa trên connection, không dựa tools map).

### 4.5. Security
- Đánh dấu output MCP là **untrusted** trong prompt (chống prompt injection).
- Redact secrets; env allowlist; không shell interpolation.
- Per-server default permission `ask`; audit log tool call.
- OAuth cho HTTP MCP: để P2 (sau khi có nhu cầu thực tế).

### 4.6. Tests
- Mock servers: stdio/http, resources/prompts, notifications, progress/cancel, reconnect, schema edge, 0-tool server, readonly no-spawn.

---

## 5. Trụ 3 — Command & Skill

### 5.1. Một command registry duy nhất
- Tạo `CommandDef`:
  ```ts
  { name, aliases, description, usage, argsSchema?, completion?, visibility, handler, source: "builtin" | "project" | "global" | "mcp" }
  ```
- Xoá danh sách trùng `SLASH_COMMANDS`; `/help` sinh từ registry.
- Chuyển `/review`, `/diff`, `/theme`, `/undo` từ `app.tsx` vào registry với `host` capability (`review()`, `diff()`, `theme()`, `snapshots()`).
- REPL, TUI, HTTP dùng cùng dispatch; command TUI-only có flag `tuiOnly`.

**File:** `src/tui/commands.ts`, `src/tui/command-registry.ts`, `src/tui/app.tsx`, `src/index.ts`.

### 5.2. Custom commands
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

### 5.3. Skills 2.0
- YAML parser hỗ trợ array/nested; thêm `version`, `tags`, `references`.
- Progressive disclosure: index → body → `references/*.md` theo yêu cầu; `load_skill` thêm `section`.
- `allowed-tools` **enforce thật**: filter tool specs trong turn skill active.
- `/skills info <name>`, `/skills lint`; cảnh báo trùng tên, thiếu description, tool không tồn tại.
- Auto-match scoring từ tags/description; model vẫn quyết định load.
- Tương thích thư mục skill kiểu Claude/opencode.

### 5.4. Command mới
`/agent`, `/plan`, `/commands`, `/memory`, `/init` (tạo `AGENTS.md`), `/export`, `/search`, `/mcp add|test|restart`, `/skill info|reload`, `/undo` + `/diff` cho REPL.

### 5.5. Completion v2
- Provider registry: commands, skills, agents, files, MCP servers/tools/resources, sessions.
- Async có loading; fuzzy; mô tả; giới hạn kết quả; ranking.
- Tab behavior thống nhất; `/review` không hardcode language/server nữa.

---

## 6. Trụ 4 — TUI

### 6.1. Event coverage
- Reducer xử lý `steer_queued`, `steer_delivered`, `compaction`, `agent_start/end`, `question_request`, `tool_progress`, `queue`.
- `toolPhase` thêm `grep`, `glob`, `task`, MCP.
- `run_start` mang `agent`, `schemaVersion`.

### 6.2. Layout & navigation
- Command palette `Ctrl+P`: command, skill, agent, file, session.
- `?` mở help overlay; `/help` mở overlay thay vì dump vào chat.
- Responsive: 80/100/120 cols; sidebar auto-hide; section ưu tiên.

### 6.3. Transcript
- Tool card collapsed 1 dòng; `Enter`/`o` expand, `c` copy item.
- `/search` hoặc `Ctrl+F`; `n/N` next/prev.
- `/export [md|json]`.
- Diff: syntax highlight, hunk navigation `[`/`]`, side-by-side khi đủ rộng.
- Subagent tree: indent, trạng thái, output gộp.
- Compaction divider + "đã tóm tắt N tin nhắn".
- Steering badge "queued/delivered".

### 6.4. Status & sidebar
- Context gauge + cost budget bar + queue/steer badge.
- MCP: latency, tool count, last error.
- Agent/model hiện tại; plan progress; adaptive sections (ẩn section rỗng).

### 6.5. Approval & ask
- Permission queue: hiện số request đang chờ; modal scroll diff.
- `ask_user` modal: single/multi choice + free text.
- Hiển thị risk level cho command nguy hiểm.

### 6.6. Accessibility & performance
- `NO_COLOR`, `--no-motion`, `--plain` (screen-reader), ASCII fallback, high-contrast theme.
- Thay `estimateItemRows` heuristic bằng đo thật + cache; memoize markdown; frame budget 50ms.
- Test 10k event scroll không lag.

### 6.7. Tests
- Reducer unit cho mọi event mới.
- PTY snapshot (`test/pty-run.py`) cho layout 80/100/120 cols.
- Perf test stream dài.

---

## 7. Thay đổi schema

### AgentEvent mới (additive)
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

### Config mới
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

---

## 8. Roadmap & estimates

| Phase | Nội dung | Effort | Phụ thuộc |
|---|---|---:|---|
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

---

## 9. Acceptance criteria & Definition of Done

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

---

## 10. Rủi ro & rollback

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Prompt V5 regress | Cao | Eval gate + feature flag `promptVersion`; rollback về V4 |
| Context bloat (repo map/memory) | Cao | Hard token budget; đo trước/sau; tắt từng phần bằng config |
| MCP third-party độc hại | Cao | Trust level, default ask, readonly no-spawn, redact, untrusted wrapper |
| TUI phình + chậm | TB | Frame budget, measured heights, PTY perf test |
| Scope creep | Cao | Phase gate; out-of-scope list |
| Backward compat | TB | Event/config additive; migration test |

**Out of scope (phase này):** web UI, cloud sync, full LSP server, vector DB/embeddings, MCP OAuth, multi-tenant auth.

---

## 11. Quick wins (làm ngay trong 1–2 ngày)

1. `read_file` thêm `offset/limit`; `grep` thêm context lines.
2. Inject `AGENTS.md` + `/init` tạo template.
3. `--agent` + `/agent` cơ bản.
4. MCP readonly không spawn; `structuredContent` pass-through; fix `mcpStatus` 0-tool.
5. TUI reducer xử lý `steer_queued/delivered`; thêm event `compaction`.
6. Sinh `/help` từ registry; bỏ hardcode `/review` language/server.
7. Sửa `timeout_secs` schema thành number.
8. `/export` transcript.
9. `ask_user` skeleton + modal.
10. Eval baseline: chạy 10 scenario, lưu JSON.

---

## 12. Checklist theo phase

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
  - [ ] `task` batch + edit fuzzy/apply_patch
  - [ ] Eval gate CI
- [ ] Phase 4 — MCP A
  - [ ] Protocol version + capabilities + instructions
  - [ ] Resources/prompts/notifications
  - [ ] HTTP SSE incremental + cancel + applyConfig restart
- [ ] Phase 5 — MCP B
  - [ ] Per-server trust/tool filters/timeouts
  - [ ] `scoder mcp` CLI + config import
  - [ ] Readonly no-spawn + untrusted output + audit log
  - [ ] Mock test suite
- [ ] Phase 6 — Command/Skill
  - [ ] Unified `CommandDef` registry
  - [ ] Custom `.scoder/commands/*.md`
  - [ ] Skills 2.0 (progressive disclosure + enforce allowed-tools)
  - [ ] Completion v2
- [ ] Phase 7 — TUI
  - [ ] Reducer event coverage
  - [ ] Command palette + help overlay
  - [ ] Transcript search/expand/export + diff nav
  - [ ] Ask/permission queue + accessibility + perf
- [ ] Phase 8 — Hardening
  - [ ] Docs + CHANGELOG
  - [ ] Migration/backward-compat test
  - [ ] Release 0.9.0
