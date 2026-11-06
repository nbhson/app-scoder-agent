# Refactor Plan — app-scoder-agent

> **Trạng thái:** ĐANG THỰC HIỆN — Phase 0, Phase 1.1–1.4, Phase 2, Phase 3 và Phase 4.1 đã hoàn tất; Phase 4 đang tiếp tục theo từng subsystem.
>
> **Ngày lập:** 06/11/2026  
> **Baseline commit:** `110e6020f3a5` — `feat(tui): show application version in header` (2026-11-06). Working tree hiện có các thay đổi refactor chưa commit.  
> **Phạm vi:** cấu trúc module, kiến trúc/layering, performance, test hygiene, docs.  
> **Ràng buộc số 1:** refactor thuần — **không đổi logic, behavior, prompt, event schema, tool schema, CLI contract hay permission semantics**.

---

## 1. Mục tiêu

1. Giảm kích thước các "god file" để dễ đọc, review, test và song song hoá công việc.
2. Sửa các vi phạm layering: core (`agent`/`tools`) không được phụ thuộc TUI/Ink/React.
3. Loại bỏ phụ thuộc vòng (kể cả type-only) và các điểm mutable state toàn cục nguy hiểm.
4. Tạo safety net đủ mạnh để chứng minh refactor không đổi behavior.
5. Cải thiện performance **có đo lường**, chỉ giữ thay đổi chứng minh được là tương đương output.
6. Đồng bộ docs với code và quy trình test thực tế.

### 1.1 Trả lời thẳng: sau plan này, nhìn source có thấy ngay kiến trúc không?

**Chưa đủ.** Nếu chỉ làm Phase 0–7 như bản hiện tại, source sẽ **dễ đọc hơn rất nhiều** nhưng chưa "tự giải thích":

| Tiêu chí | Sau Phase 0–7 | Vì sao |
|---|---|---|
| Nhìn `src/` biết ngay domain | Một phần | Chỉ 4 file lớn được tách; ~30 module core vẫn nằm phẳng ở root |
| Phân biệt public API và implementation | Chưa rõ | Facade và implementation cùng tồn tại; dễ sửa nhầm facade hoặc import vòng |
| Biết module nào được phép import module nào | Có guard nhưng không trực quan | Cần graph + module charter ngay trong source |
| Clean code trong từng file | Chưa đảm bảo | Move-only giữ nguyên long function, boolean flag, dead code, `any` cũ |
| Performance có bằng chứng | Một phần | Benchmark hiện tại là micro; chưa có workload thật (repo lớn, session dài, nhiều skill) |
| Người mới tự tìm được luồng chính | Chưa chắc | Cần "5-minute orientation" + README theo domain |

Kết luận: plan hiện tại là **refactor an toàn để giảm rủi ro**, chưa phải **kiến trúc tự hiển hiện**. Muốn đạt câu trả lời "có", phải thêm §5.2 + Phase 8 (domain migration & clean-code hardening) và performance budget thực tế ở Phase 6.

## 2. Không nằm trong phạm vi

- Không thêm feature, không đổi prompt, không đổi model/provider behavior.
- Không sửa bug tiềm ẩn trong cùng PR refactor (xem §9). Bug fix có PR riêng.
- Không đổi public API/package contract; không đổi `bin`, `main`, tên package.
- Không big-bang restructure; không đổi toàn bộ import style.
- Không thêm dependency mới cho refactor (trừ dependency phục vụ dev tooling nếu thật sự cần và được duyệt riêng).
- Không format lại toàn repo, không đổi quote style/line ending hàng loạt.

---

## 3. Baseline hiện tại

### 3.1 Kích thước

| Khu vực | Số liệu |
|---|---:|
| `src/**/*.ts,tsx` | 58 files, ~18.222 LOC |
| `test/**` | ~9.377 LOC |
| File lớn nhất | `src/agent.ts` 2.041 · `src/tools/registry.ts` 355 · `src/mcp/manager.ts` 523 · `src/index.ts` 833 · `src/tui/app.tsx` 800 · `src/permissions.ts` 715 · `src/llm.ts` 572 · `src/guardrails.ts` 549 · `src/tui/command-registry.ts` 542 · `src/tui/state.ts` 530 |

### 3.2 Quality gates

| Lệnh | Kết quả baseline |
|---|---|
| `npm run typecheck` | pass, 0 lỗi |
| `npm run lint` | pass, 0 lỗi |
| `SCODER_NO_WATCH=1 npm test` | pass (unit + e2e + MCP smoke) |
| `npm test` (không env) | **treo** ở `test/steer.test.mjs` do watcher không được dispose |
| `npm run eval` | 11/11 scenario pass |
| `SCODER_NO_WATCH=1 npm run coverage` | 87,78% line · 81,20% branch · 91,21% function |

### 3.3 Vấn đề kiến trúc đã xác nhận

| ID | Vấn đề | Bằng chứng |
|---|---|---|
| A1 | Core import TUI | resolved in Phase 1: `agent.ts` → `file-index.ts`; tool image code → `media/image.ts` |
| A2 | Core gọi console singleton | resolved in Phase 1.4: core uses `Reporter`; default adapter forwards to `ui.ts` |
| A3 | CLI import command registry nằm trong `tui/` | `src/index.ts` → `src/tui/command-registry.ts` |
| A4 | Type-only cycle | resolved in Phase 1.3: shared contracts live in `tools/types.ts` |
| A5 | Module-level mutable state | `MAX_OUTPUT_CHARS` (`tools.ts`), `cache` (`tui/at-complete.ts`), `skillWarnings` (`skills.ts`) |
| A6 | TUI reducer mutate state | `applyEvent()` sửa `state` tại chỗ dù docs ghi "pure reducer" |
| A7 | Virtualization có nhưng chưa dùng | `visibleWindow()` tồn tại; `app.tsx` vẫn `items.map(...)` toàn bộ (tối đa 400 item) |
| A8 | Cache file-index không theo workdir | `fileIndex(workdir)` dùng một biến `cache` toàn cục |

### 3.4 Benchmark baseline (cùng máy, tham khảo)

| Case | Thời gian |
|---|---:|
| `repoMapKey` | ~2.9 ms |
| `buildRepoMap` (warm) | ~1.9 ms |
| `renderRepoMap` | ~10.9 ms |
| `discoverSkills` | ~6.2 ms |
| `findSkill` × 20 | ~4.8 ms |
| `buildEnvInfo` | ~13 ms |
| `fileIndex` cold / warm | ~6.5 ms / ~0 ms |
| `estimateTokens` (1.200 messages) | ~0.7 ms |
| `trimHistory` | không đáng kể |

> Các số trên chỉ để chọn việc, không phải cam kết. Phase 0 sẽ tạo benchmark harness chuẩn và lưu JSON baseline.

---

## 4. Compatibility contract (bắt buộc)

Tests hiện import trực tiếp từ `dist/*.js` (ví dụ `../dist/agent.js`, `../dist/tools.js`, `../dist/mcp.js`, `../dist/tui/state.js`). Vì vậy:

1. **Mọi module path cũ phải tiếp tục tồn tại** và export đúng tên cũ.
2. File facade được giữ tại:
   - `src/agent.ts`
   - `src/tools.ts`
   - `src/mcp.ts`
   - `src/index.ts`
   - `src/tui/image.ts`
   - `src/tui/at-complete.ts`
   - `src/tui/commands.ts`
   - `src/tui/command-registry.ts`
   - `src/tui/transcript.ts`
   - `src/tui/state.ts`
3. Implementation có thể chuyển vào thư mục con; facade chỉ re-export.
4. Không đổi:
   - `AgentEvent` union/schema version 2.
   - Tool JSON schema, tên tool, thứ tự `allToolSpecs()`.
   - Prompt text (snapshot sau khi normalize ngày/git branch).
   - CLI help/error text, exit code, `parseArgs` behavior.
   - Permission modes, rule engine, config precedence.
   - Session file format và event log format.
5. `package.json` giữ nguyên `main: dist/index.js`, `bin.scoder`, `type: module`.
6. `src/index.ts` giữ shebang `#!/usr/bin/env node` và vẫn là entry duy nhất.

**Cách enforce:** test snapshot export surface + test import facade + architecture guard (§6 Phase 0).

---

## 5. Kiến trúc đích

> Cây dưới là **trạng thái cuối sau Phase 8**. Trong Phase 1–7, các module chưa move vẫn nằm ở root; Phase 8 hoàn thiện cây domain. Với Option A, mỗi module đã move vẫn có facade ≤ 20 dòng tại path cũ.

```
src/
├── index.ts                     # entry: shebang + gọi cli/main
├── cli/
│   ├── main.ts                  # composition root
│   ├── args.ts                  # parseArgs, CliArgs, help
│   ├── run-once.ts
│   ├── repl.ts
│   ├── init.ts
│   └── mcp-command.ts
├── agent.ts                     # facade re-export (Option A)
├── agent/
│   ├── agent.ts                 # class Agent + constructor/wiring
│   ├── types.ts                 # AgentEvent, AgentRunResult, UsageTotals...
│   ├── run-loop.ts              # vòng lặp chính
│   ├── tool-executor.ts         # executeToolCall + parallel tool batch
│   ├── mcp-bridge.ts            # connect/rebuild/status/call/confirm
│   ├── interaction.ts           # permission + ask_user broker
│   ├── verification.ts          # build/verify/self-review
│   ├── prompt-context.ts        # system prompt, repo map, skills, memory
│   └── session-persistence.ts   # save/resume/compaction persistence
├── tools.ts                     # facade re-export
├── tools/
│   ├── types.ts                 # ToolResult, ToolDiff, ToolContext, AgentTool...
│   ├── path-safety.ts           # safePath, protected env, clamp
│   ├── read-file.ts
│   ├── write-file.ts
│   ├── edit-file.ts
│   ├── apply-patch.ts
│   ├── list-files.ts
│   ├── search.ts                # grep/glob/walkFiles
│   ├── run-command.ts           # env, shell, sandbox
│   ├── webfetch.ts              # web_fetch transport
│   ├── task-tool.ts
│   ├── ask-user-tool.ts
│   ├── todo-tool.ts
│   ├── schemas.ts               # helper JSON schema
│   └── registry.ts              # AGENT_TOOLS, getTool, allToolSpecs
├── mcp.ts                       # facade re-export
├── mcp/
│   ├── types.ts
│   ├── env.ts                   # expandEnv
│   ├── sse.ts                   # parseSseEvent/Messages
│   ├── transport-stdio.ts
│   ├── transport-http.ts
│   ├── connection.ts            # McpConnection + reconnect
│   ├── manager.ts               # McpManager
│   └── import.ts                # mcp-import config
├── llm/                         # Phase 8
│   ├── llm.ts
│   ├── provider-anthropic.ts
│   ├── provider-registry.ts
│   ├── model-catalog.ts
│   └── retry.ts
├── context/                     # Phase 8
│   ├── context.ts
│   ├── compaction.ts
│   ├── prompt.ts
│   ├── prompt-builder.ts
│   ├── repo-map.ts
│   ├── memory.ts
│   ├── skills.ts
│   ├── agents.ts
│   └── agents-guide.ts
├── workspace/                   # Phase 8
│   ├── build.ts
│   ├── diff.ts
│   ├── snapshot.ts
│   ├── diagnostics.ts
│   ├── file-index.ts
│   └── watch.ts
├── security/                    # Phase 8
│   ├── permissions.ts
│   ├── sandbox.ts
│   └── shell-scanner.ts
├── session/                     # Phase 8
│   ├── session.ts
│   ├── logger.ts
│   ├── steering.ts
│   └── cost.ts
├── config/
│   └── config.ts
├── commands/                    # command dùng chung REPL + TUI
│   ├── registry.ts
│   ├── definitions.ts           # parse/format slash commands
│   └── transcript.ts
├── io/
│   ├── reporter.ts              # port: info/warn/toolCall/stream...
│   ├── console-reporter.ts      # adapter mặc định → ui
│   └── terminal.ts              # low-level output (move từ src/ui.ts)
├── media/
│   └── image.ts                 # pure image helpers (move từ tui/image)
├── server/
│   └── server.ts                # HTTP/SSE
├── shared/
│   ├── constants.ts
│   ├── version.ts
│   └── json-schema.ts
├── providers/                   # optional Phase 7
│   ├── sse.ts
│   ├── http.ts
│   └── stream.ts
├── tui/                         # chỉ frontend Ink/React
│   ├── app.tsx                  # composition + JSX
│   ├── hooks/                   # use-agent, use-events, use-input, use-scroll
│   ├── state.ts                 # facade → state/
│   └── ...
└── ui.ts                        # facade re-export terminal (Option A)
```

### 5.1 Quy tắc phụ thuộc

```
cli/ + tui/  ──▶ agent/ ──▶ tools/ + mcp/ + providers/
     │              │
     └──────────────┴──────▶ core modules
                              (config, llm types, permissions, session,
                               artifacts, compaction, guardrails...)

tools/ ──▶ tools/types + core
core   ──✗──▶ tui/, ink, react
tui/   ──▶ mọi thứ (frontend)
io/    ──▶ ui.ts (chỉ adapter)
```

- **Không runtime cycle.** Type-only cycle cũng bị cấm sau Phase 1.
- `src/tui/state.ts` chỉ được import **type** từ agent; không import value.
- `src/agent.ts`/`src/tools.ts`/`src/mcp.ts` facade chỉ re-export, không chứa logic.
- `src/ui.ts` là terminal adapter cấp thấp, không phải TUI. Chỉ `io/console-reporter.ts` và composition root được import trực tiếp.

### 5.2 Source-code discoverability contract

Để "nhìn source là thấy kiến trúc", sau refactor phải đáp ứng các điểm sau (được kiểm trong Phase 8):

1. **Root `src/` chỉ còn entry + facade công khai.** Mỗi file còn lại ở root phải là shim ≤ 20 dòng, có header:
   ```ts
   /**
    * LEGACY PUBLIC PATH — compatibility facade.
    * Implementation: src/tools/registry.ts
    * Do not add logic here.
    */
   export * from "./tools/registry.js";
   ```
2. **Mỗi domain có một `README.md` ngắn (10–20 dòng)** nêu: trách nhiệm, public API, được phép import gì, không được làm gì. Ví dụ `src/agent/README.md`, `src/tools/README.md`, `src/mcp/README.md`.
3. **Public API của domain nằm ở `index.ts` hoặc facade rõ ràng.** Internal module không được re-export tràn lan; ai đọc folder biết ngay file nào là entry.
4. **Tên file = danh từ/mục đích, không viết tắt mơ hồ.** Ví dụ `transport-stdio.ts`, `session-persistence.ts`, `path-safety.ts`; tránh `utils.ts`, `helpers.ts`, `common.ts` gom rác.
5. **Generated dependency graph** (`docs/architecture-graph.md`) sinh từ `scripts/check-layers.mjs --graph`, CI kiểm tra graph còn fresh. Nhìn graph là thấy layer, không cần đọc import.
6. **5-minute orientation:** `docs/onboarding.md` map 10 luồng chính → file:
   - CLI start → `cli/main.ts`
   - agent loop → `agent/run-loop.ts`
   - một tool call → `agent/tool-executor.ts` + `tools/registry.ts`
   - permission → `agent/interaction.ts` + `security/permissions.ts`
   - MCP connect/call → `agent/mcp-bridge.ts` + `mcp/manager.ts`
   - TUI event → `tui/state.ts` + `tui/hooks/use-events.ts`
   - session/resume → `session/`
   - compaction → `context/compaction.ts`
   - build verify → `agent/verification.ts` + `workspace/build.ts`
   - prompt → `context/prompt-builder.ts`
7. **Clean-code budgets có thể kiểm tự động:** max file/function length, complexity, depth, params, cấm `console` trong core (xem Phase 8.3). Nếu không có budget, sau 6 tháng các god file sẽ quay lại.

---

## 6. Kế hoạch theo phase

### Phase 0 — Safety net & baseline (bắt buộc, làm trước mọi thay đổi)

**Mục tiêu:** có lưới an toàn chứng minh "không đổi behavior", và test suite chạy ổn định không cần workaround.

**Công việc**

1. **Chốt baseline**
   - Ghi commit SHA, version Node/npm, OS.
   - Chạy và lưu log: `npm ci`, `lint`, `typecheck`, `build`, `SCODER_NO_WATCH=1 npm test`, `npm run eval`, `npm run coverage`.
   - Lưu coverage thực tế (line/branch/function) vào `plan/baseline/`.

2. **Sửa test isolation gây treo (test-only, commit riêng)**
   - `test/steer.test.mjs`: tạo Agent với `noSave: true` (đồng thời tắt watcher theo điều kiện hiện có) và gọi `agent.dispose()` trong `finally`/`after`.
   - Rà các test khác tạo `Agent` mà không dispose; thêm helper `withAgent()` hoặc `after()`.
   - Thêm timeout cho test process/CI (ví dụ `--test-timeout` nếu Node hỗ trợ, và `timeout-minutes` trong CI).
   - **Definition of done:** `npm test` pass **không cần** `SCODER_NO_WATCH=1`, không còn handle treo.

3. **Characterization tests (behavior lock)**
   - `test/contracts.test.mjs`: import mọi public module từ `dist/`, so sánh sorted export names với fixture JSON.
   - `test/tool-schemas.test.mjs`: snapshot `allToolSpecs()` (tên, description, parameters) theo stable stringify.
   - `test/prompt-snapshot.test.mjs`: `buildSystemPrompt` với config cố định; normalize ngày/git branch; so sánh hash.
   - `test/event-golden.test.mjs`: chạy mock LLM scenario, ghi `AgentEvent[]` (bỏ timestamp), so sánh JSON fixture. Ít nhất: run_start → tool_call → tool_result → assistant → build → run_end; permission flow; abort.
   - `test/cli-contract.test.mjs`: bảng `parseArgs` (mọi flag + tổ hợp), help text, exit code.
   - `test/tui-reducer.test.mjs`: fixture cho toàn bộ `AgentEvent` type; snapshot state sau từng event.
   - `test/mcp-contract.test.mjs`: fixture SSE/stdin frames, danh sách tool/resource.
   - `test/facade.test.mjs`: mỗi path cũ import được và named export cũ tồn tại.

4. **Architecture guard**
   - `scripts/check-layers.mjs` (không thêm dependency): parse import statements, enforce §5.1.
   - Allowlist hiện còn duy nhất `index.ts → tui/command-registry.ts`; A1/A2/A4 đã được xử lý ở Phase 1.
   - CI fail nếu vi phạm mới; allowlist chỉ được giảm, không tăng.

5. **Benchmark harness**
   - `scripts/bench.mjs`: chạy in-process, warmup + median 5 lần, output JSON.
   - Case: `repoMapKey`, `buildRepoMap` cold/warm, `renderRepoMap`, `discoverSkills`, `findSkill`, `buildEnvInfo`, `fileIndex`, `estimateTokens`, `trimHistory`.
   - Lưu baseline `plan/baseline/bench-<sha>.json`; script so sánh `--compare`.

6. **Verify script**
   - Thêm `npm run verify` = `lint && typecheck && build && test && eval` (giữ `npm test` tương thích).
   - CI dùng `npm run verify`; coverage job riêng.

**Gate:** tất cả characterization tests pass trên code **chưa refactor**. Nếu snapshot khác nhau giữa các lần chạy → làm test ổn định trước, không tiếp tục.

**Thời lượng ước tính:** 1–2 ngày.

---

### Phase 1 — Sửa layering cơ bản (move-first, behavior-preserving)

**Mục tiêu:** core không còn import TUI; loại type cycle; có port cho output.

#### 1.1 Move image helpers ra khỏi TUI

- Chuyển nguyên `src/tui/image.ts` → `src/media/image.ts` (không sửa logic).
- `src/tui/image.ts` thành facade `export * from "../media/image.js";`.
- `src/tools.ts` import `detectImageBytes` từ `./media/image.js`.
- Test hiện import `dist/tui/image.js` vẫn pass.

#### 1.2 Move file-index/@-completion ra khỏi TUI

- Chuyển `src/tui/at-complete.ts` → `src/file-index.ts`.
- `src/tui/at-complete.ts` thành facade re-export.
- `src/agent.ts` import `invalidateFileIndex` từ `./file-index.js`.
- Chưa sửa cache toàn cục ở bước này (bug fix riêng, §9).

#### 1.3 Tách tool types, phá type-only cycle

- Tạo `src/tools/types.ts` chứa: `ToolDiff`, `ToolResult`, `ToolContext`, `AgentTool`, `AskUserRequest`, `TodoItem`, `TaskSpec`, `TaskRunner`, `CommandOutputListener`.
- `src/tools.ts` import và re-export các type này.
- `src/webfetch.ts` import type từ `./tools/types.js`.
- `src/agent.ts` vẫn import từ `./tools.js` (facade) để giảm diff.
- Kiểm tra `tsc --noEmit` không còn cycle; architecture guard bật rule cấm `tools ↔ webfetch`.

#### 1.4 Output port (bỏ core → `ui.ts` trực tiếp)

- Tạo `src/io/reporter.ts`:
  ```ts
  export interface Reporter {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    // ... các method agent/tools thực dùng
  }
  ```
- `src/io/console-reporter.ts` là adapter mặc định forward sang `ui.*`, giữ nguyên output từng byte.
- `Agent` nhận `reporter` optional (constructor arg hoặc config field nội bộ), mặc định `consoleReporter`.
- `ToolContext` có `reporter?: Reporter`; các chỗ `ui.printDiff/info/warn` trong tools dùng `ctx.reporter ?? consoleReporter`.
- `index.ts`/`server.ts` truyền reporter tương ứng; TUI vẫn dùng `setQuiet(true)` như cũ.
- **Không đổi default output**; đây là dependency injection, không phải đổi UX.

#### 1.5 Dọn allowlist

- Xoá entry A1/A2 khỏi architecture guard.
 - `index.ts → tui/command-registry` để Phase 5 (ghi rõ lý do).

**Gate:** full test + e2e + MCP + eval pass; export snapshot không đổi; `check-layers` pass với allowlist đã giảm; benchmark không regression >5%.

**Thời lượng ước tính:** 2–3 ngày.

---

### Phase 2 — Tách `src/tools.ts` (1.408 → facade ≤ 120 dòng)

**Nguyên tắc:** move code nguyên khối trước, **không sửa logic** trong cùng commit. Mỗi nhóm tool là một commit độc lập.

**Thứ tự đề xuất**

1. `tools/types.ts` + `tools/path-safety.ts` (`safePath`, `clamp`, `toResult`, `isProtectedEnvFile`, `toPosInt`).
2. `tools/read-file.ts`, `tools/list-files.ts`.
3. `tools/write-file.ts`, `tools/edit-file.ts`, `tools/apply-patch.ts` (giữ chung `gateWrite`, `wsInsensitiveRegex`, `applyOneEdit` trong `file-edit-common.ts` nếu cần).
4. `tools/search.ts`: `walkFiles`, `SEARCH_SKIP`, `toolGrep`, `jsGrepFallback`, `globToRegExp`, `toolGlob`.
5. `tools/run-command.ts`: `formatFile`, `BASE_ENV_KEYS`, `buildChildEnv`, `defaultShellArgv`, `findGitBash`, `toolRunCommand`, `CommandOutputListener`.
6. `tools/task-tool.ts`, `tools/ask-user-tool.ts`, `tools/todo-tool.ts`.
7. `tools/schemas.ts` + `tools/registry.ts`: `AGENT_TOOLS`, `getTool`, `allToolSpecs`.
8. `src/tools.ts` chỉ còn re-export public API + types.

**Lưu ý**

- `AGENT_TOOLS` là mảng có thứ tự; giữ nguyên thứ tự phần tử.
- Các closure `execute` truy cập `ctx`; khi move phải giữ nguyên tham chiếu.
- `MAX_OUTPUT_CHARS` vẫn giữ semantics global trong phase này; không đổi thành per-context (bug fix riêng).
- `toolWebFetch` vẫn nằm ở `webfetch.ts`; registry import như cũ.
- Không đổi message lỗi, truncation, diff format.

**Gate:** `tools.test.mjs`, `search-tools.test.mjs`, `limits.test.mjs`, `sandbox.test.mjs`, `env-policy.test.mjs`, `tui-image.test.mjs`, `tool-schemas` snapshot; full suite.

**Thời lượng ước tính:** 2–3 ngày.

---

### Phase 3 — Tách `src/mcp.ts` (1.134 → facade ≤ 150 dòng)

> **Đã hoàn tất move-only:** facade còn 11 dòng; các module types/env/SSE/transport/connection/manager đã được tách. `mcp/manager.ts` hiện 523 dòng vì giữ nguyên resource/prompt dispatch trong cùng class để bảo toàn state machine; mục tiêu ≤350 dòng/file được ghi nhận là exception cần xử lý ở một phase clean-code riêng, không trộn vào move này.

**Thứ tự**

1. `mcp/types.ts`: config, tool/resource/prompt types, `McpConnState`, `RegisteredMcpTool`.
2. `mcp/env.ts`: `expandEnv`.
3. `mcp/sse.ts`: `parseSseEvent`, `parseSseMessages`.
4. `mcp/transport-stdio.ts`: `StdioTransport`.
5. `mcp/transport-http.ts`: `HttpTransport`.
6. `mcp/connection.ts`: `McpConnection` + reconnect constants/backoff.
7. `mcp/manager.ts`: `McpManager`.
8. `src/mcp.ts`: facade re-export toàn bộ public API.

**Lưu ý**

- `StdioTransport`/`HttpTransport` phải giữ nguyên timeout, buffer, parse frame, cleanup handle.
- `McpConnection` giữ nguyên state machine `connecting/ready/reconnecting/dead/disabled`.
- `McpManager` giữ nguyên cách đặt tên `mcp__server__tool`, permission/untrusted flags.
- Không đổi log messages (có thể được assert trong test).
- Test import `dist/mcp.js`; facade đảm bảo tương thích.

**Gate:** `mcp-phase4`, `mcp-phase5`, `mcp-http`, `mcp-reconnect`, `mcp-permission`, `mcp-import`, `mcp-cli`, `run-mcp-test.mjs`, full suite.

**Thời lượng ước tính:** 1,5–2 ngày.

---

### Phase 4 — Tách `src/agent.ts` (2.041 → facade ≤ 120, implementation ≤ 900)

Đây là phase rủi ro cao nhất. Làm **từng subsystem một**, mỗi bước là một PR/commit revertible. Không gộp nhiều subsystem trong một commit.

**Thứ tự an toàn**

1. **`agent/types.ts`**
   - `AgentRunResult`, `VerificationInfo`, `UsageTotals`, `AgentEvent`, `ResolvedPrimary`.
   - `EVENT_SCHEMA_VERSION`, `resolvePrimaryConfig` (pure).
   - `src/agent.ts` re-export.

   **Status:** Hoàn tất. Verification gate sau bước này: `npm test` 867/867, `npm run eval` 11/11, build/lint/typecheck/layer check pass; public exports của `dist/agent.js` không đổi.

2. **`agent/verification.ts`**
   - `resolveVerify`, `verifyAll`, `failureSignature`, `collectRunDiff`, `selfReviewGate`, `buildCmd` getter.
   - Truyền dependencies tường minh (config, run command, emit, reporter).

   **Status:** Hoàn tất bước move-only. `Agent` giữ các delegate private để bảo toàn call sites và public surface; verification event/log order và state transitions không đổi.

3. **`agent/mcp-bridge.ts`**
   - `connectMcp`, `rebuildToolList`, `shutdownMcp`, `mcpStatus`, `callMcpTool`, `confirmMcpTool`, `invokeMcpTool`.
   - Giữ nguyên thứ tự tool specs và permission check.

   **Status:** Hoàn tất bước move-only. MCP bridge nhận dependency runtime tường minh; `Agent` giữ delegate private/public để bảo toàn transport, tool ordering, event/log và permission semantics.

4. **`agent/interaction.ts`**
   - `pendingPermissions`, `permSeq`, `programmaticPermissionPrompt`, `resolvePermission`.
   - `onQuestion`, `questionSeq`, `askUser` bridge.
   - Có thể tách thành `InteractionBroker` class; Agent giữ method public delegate.

   **Status:** Hoàn tất bước move-only. `InteractionBroker` giữ timeout, fallback deny, event payload và public `Agent` delegates nguyên trạng.

5. **`agent/tool-executor.ts`**
   - `executeToolCall`, `parallelMap`, `pushToolResult`, `rejectToolCall`, `handleToolOutput`, `endToolStream`.
   - `READONLY_TOOLS` và logic permission/readonly.
   - Dependencies: `getTools()`, permissions, reporter, emit, MCP bridge, interaction broker, snapshot/diff.
   - **Không đổi thứ tự emit event** và cách ghép parallel results.

   **Status:** Hoàn tất extraction move-only cho `executeToolCall`, `parallelMap`, `rejectToolCall`, `READONLY_TOOLS` và permission/MCP dispatch. `Agent` vẫn giữ các stateful message/stream helpers (`pushToolResult`, `handleToolOutput`, `endToolStream`) làm delegates/dependencies để giảm rủi ro event ordering.

6. **`agent/prompt-context.ts`**
   - `memoryBlock`, `buildSystemPrompt` inputs, repo map, skills block, agents block, MCP block, AGENTS.md.
   - `getSkills`, `reloadSkills`, `stageSkill` nếu tách được thành `SkillService`.

   **Status:** Hoàn tất bước move-only. `PromptContext` giữ discovery/reload/staging của skill và `buildRunMessages` giữ nguyên composition/thứ tự system, staged-context, task; `Agent` vẫn giữ public delegates.

7. **`agent/session-persistence.ts`**
   - `saveSession`, phần load/resume projection, `compactHistory` persistence.
   - Không đổi JSON shape/atomic write.

8. **`agent/run-loop.ts` (bước cuối, optional nếu risk cao)**
   - Extract `runLoop` với `RunLoopDeps` interface tường minh (messages, tools, emit, guardrails, compaction, verification, steering).
   - `Agent.run/runTurn/resume` vẫn là public API, delegate vào loop.
   - Nếu sau 2 ngày vẫn không đạt tương đương event order → dừng, giữ `runLoop` trong `agent.ts`, ghi lại lý do. Không ép split bằng mọi giá.

**Chiến lược test**

- Trước mỗi bước: thêm characterization test riêng cho subsystem đó (nếu chưa có).
- So sánh event log golden sau mỗi bước.
- Test permission flow, abort/SIGINT, steer, queue, hot-reload, MCP, compaction, resume.
- Không đổi `private` thành `public` chỉ để test; dùng dependency injection hoặc test qua public API.

**Gate:** `agent-v2`, `event-v2`, `steer`, `steering`, `hot-reload`, `permission-*`, `compaction`, `session-v2`, `mcp-*`, `run-e2e`, `run-eval`; full suite; event golden.

**Thời lượng ước tính:** 4–6 ngày.

---

### Phase 5 — Tách CLI và TUI

#### 5.1 `src/index.ts` (833 → entry ≤ 80)

Tách:

- `cli/args.ts`: `CliArgs`, `parseArgs`, help text.
- `cli/run-once.ts`: `runOnce`.
- `cli/repl.ts`: REPL loop.
- `cli/init.ts`: `runInit`.
- `cli/mcp-command.ts`: `runMcpCommand`.
- `cli/main.ts`: `main()` + composition root.
- `src/index.ts`: giữ shebang, import `main`, gọi `main()`.
- `parseArgs` vẫn re-export từ `src/index.ts` cho test.

#### 5.2 Command registry ra khỏi TUI

- Move `src/tui/command-registry.ts` → `src/commands/registry.ts`.
- Move `src/tui/commands.ts` → `src/commands/definitions.ts` (pure parse/format).
- Move `src/tui/transcript.ts` → `src/commands/transcript.ts` (pure).
- Giữ facade tại path cũ.
- Loại bỏ type import `ChatItem` khỏi registry bằng type tối thiểu trong `commands/types.ts` (hoặc chỉ import type, nhưng mục tiêu là commands không phụ thuộc TUI).
- `index.ts` import từ `commands/`, xoá allowlist A3.

#### 5.3 `src/tui/app.tsx` (800 → ≤ 450)

Tách hooks theo trách nhiệm:

- `tui/hooks/use-agent.ts`: create/dispose agent, refs, lifecycle.
- `tui/hooks/use-events.ts`: event queue + batching + `applyEvent`.
- `tui/hooks/use-input.ts`: key handling, slash commands, history.
- `tui/hooks/use-scroll.ts`: scroll offset, mouse.
- `tui/components/...` nếu JSX tách được mà không đổi render tree.
- `app.tsx` còn composition + layout.

**Lưu ý:** không đổi thứ tự render, key, text, ANSI output. Test `tui-render`, `tui-progress`, `tui-sidebar`, `tui-vim`, `permission-modal`, `review-flow`.

#### 5.4 `tui/state.ts` (530 → ≤ 400, optional)

- Tách selectors thuần (`latestPlan`, `visibleWindow`, `toolPhase`, `estimateItemRows`) sang `tui/selectors.ts` + facade re-export.
- Giữ nguyên `applyEvent` mutation semantics (bug/docs mismatch xử lý riêng).
- Không đổi state shape.

**Gate:** full suite + TUI tests + `tui-render` snapshot; `parseArgs` contract; CLI smoke `node dist/index.js --help`.

**Thời lượng ước tính:** 2–3 ngày.

---

### Phase 6 — Performance có đo lường (sau khi cấu trúc ổn định)

**Nguyên tắc:** chỉ tối ưu khi (a) benchmark cho thấy đáng kể, (b) output snapshot **giống hệt**, (c) có rollback dễ. Mỗi thay đổi là PR riêng, không trộn với move.

| # | Việc | Kỳ vọng | Rủi ro | Ghi chú |
|---|---|---|---|---|
| P1 | `buildRepoMap`: walk một lần, dùng lại `WalkedFile[]` cho key + render | giảm ~30–50% cold path | thấp | public `renderRepoMap` vẫn walk riêng; chỉ internal path dùng chung |
| P2 | `buildEnvInfo`: memoize theo `(workdir, ngày, platform, node version)` trong một run | ~13ms → ~0 khi lặp | thấp | không cache qua ngày; prompt build 1 lần/run |
| P3 | `discoverSkills`: chỉ discover 1 lần cho mỗi lần build prompt; `findSkill` dùng index trong cùng run | ~4.8ms → ~0.2ms | trung bình | hot-reload có thể cần invalidate; test `/skill` sau reload |
| P4 | TUI: dùng `visibleWindow(items, viewportRows)` thay vì render toàn bộ | render bounded theo viewport | **cao** | thay đổi output terminal ngoài viewport; cần user approve + test scroll; nếu không chắc thì để lại |
| P5 | `fileIndex`: key cache theo `workdir` | sửa bug + tránh sai dữ liệu | trung bình | đây là bug fix, tách PR riêng (§9) |
| P6 | `estimateTokens`/`trimHistory` | không làm | — | baseline đã đủ nhanh; tránh micro-optimize |
| P7 | Benchmark workload thật: repo tổng hợp 5.000 file, 100 skill, session TUI 400 item, agent step không gọi LLM | có baseline + budget, CI chặn regression | thấp | microbench hiện tại không đại diện workload thật |

**Quy trình**

1. Chạy `node scripts/bench.mjs --compare plan/baseline/bench-<sha>.json` trước/sau.
2. Lưu kết quả vào `plan/baseline/`.
3. So sánh output golden (repo map string, prompt, event log).
4. Chấp nhận nếu case mục tiêu nhanh hơn ≥20% và không case nào chậm hơn >5%; nếu không, revert.
5. Không thêm cache vĩnh viễn nếu không xác định được key invalidation đầy đủ.
6. Với P7, ghi thêm RSS memory (peak) và thời gian cold start `node dist/index.js --help`; budget đặt theo baseline + 10%, không đặt số tuyệt đối khi chưa đo.

**Performance budget tối thiểu (điền sau baseline Phase 0)**

| Workload | Metric | Budget |
|---|---|---|
| Repo 5.000 file | `buildRepoMap` cold | ≤ baseline + 10% |
| Repo 5.000 file | `repoMapKey` + cache hit | ≤ 50 ms |
| 100 skill | `discoverSkills` một lần | ≤ 20 ms |
| Session 400 item | TUI render mỗi event | ≤ 16 ms (1 frame) |
| Agent step (mock LLM) | overhead ngoài LLM | ≤ baseline + 10% |
| Cold start | `--help` đến exit | ≤ baseline + 10% |

> Nếu workload thật không đạt budget vì lý do ngoài phạm vi refactor, ghi rõ và tách issue performance riêng; không hạ budget âm thầm.

**Gate:** full suite + benchmark report + output snapshot identical.

**Thời lượng ước tính:** 2–4 ngày (P4 có thể bỏ).

---

### Phase 7 — Optional: dedup provider/SSE (chỉ khi cần)

`src/llm.ts` (572) và `src/provider-anthropic.ts` (512) có logic trùng: SSE parse, idle timeout, retry, `combinedSignal`, redaction. Có thể tách:

- `providers/sse.ts`: parse event/data lines.
- `providers/http.ts`: `combinedSignal`, `readWithIdleTimeout`, retry/backoff, `toLlmError`.
- `providers/stream.ts`: reader loop + tool-call accumulation.

**Không làm nếu Phase 4 chưa ổn định.** Rủi ro cao vì ảnh hưởng trực tiếp network behavior. Test bắt buộc: `llm`, `anthropic`, `anthropic-cache`, idle timeout, 429/retry, abort.

**Thời lượng ước tính:** 2–3 ngày (optional).

---

### Phase 8 — Domain migration & clean-code hardening (khuyến nghị mạnh)

**Mục tiêu:** biến source tree thành tài liệu kiến trúc, không chỉ giảm LOC. Nếu bỏ phase này, plan vẫn "gọn hơn" nhưng chưa đạt tiêu chí "nhìn source là thấy ngay structure/architecture".

#### 8.1 Domain migration phần core còn phẳng

Di chuyển các module core còn lại vào domain rõ nghĩa. Mỗi domain là một PR move-only, giữ facade root trong giai đoạn chuyển tiếp.

| Domain đích | Modules | Trách nhiệm |
|---|---|---|
| `src/llm/` | `llm.ts`, `provider-anthropic.ts`, `provider-registry.ts`, `model-catalog.ts`, `retry.ts` | Giao thức LLM, provider, retry, catalog |
| `src/context/` | `context.ts`, `compaction.ts`, `prompt.ts`, `prompt-builder.ts`, `repo-map.ts`, `memory.ts`, `skills.ts`, `agents.ts`, `agents-guide.ts` | Prompt, context window, compaction, memory, skill/agent discovery |
| `src/workspace/` | `build.ts`, `diff.ts`, `snapshot.ts`, `diagnostics.ts`, `file-index.ts`, `watch.ts` | Trạng thái workspace, build/verify, diff, snapshot, file index, watcher |
| `src/security/` | `permissions.ts`, `sandbox.ts`, `shell-scanner.ts` | Permission, sandbox, shell scanning |
| `src/session/` | `session.ts`, `logger.ts`, `steering.ts`, `cost.ts` | Session, event log, steering, cost |
| `src/config/` | `config.ts` | Config load/precedence |
| `src/shared/` | `constants.ts`, `version.ts`, `json-schema.ts` | Types/constants/util dùng chung |
| `src/io/` | `ui.ts` → `io/terminal.ts`, reporter/console-reporter | Terminal output adapter + reporter port |
| `src/server/` | `server.ts` | HTTP/SSE delivery |
| `src/tools/` | thêm `webfetch.ts` nếu tách được | Tool implementation |
| `src/mcp/` | thêm `mcp-import.ts` | MCP integration |

**Thứ tự move:** `shared → config → security → session → workspace → context → llm → io/server → tools/mcp leftovers`. Lý do: đi từ module ít phụ thuộc đến module phụ thuộc nhiều.

**Hai lựa chọn tương thích — phải chốt trước Phase 8:**

- **Option A — Giữ toàn bộ facade root (an toàn nhất):**
  - Mọi path cũ vẫn import được; root có ~30 shim ≤ 20 dòng, header `LEGACY PUBLIC PATH`.
  - Source root trông còn file, nhưng mỗi file nói rõ "implementation ở đâu"; domain folder là nơi đọc chính.
  - Phù hợp nếu còn consumer bên ngoài import `dist/<module>.js`.

- **Option B — Chỉ giữ facade công khai (sạch hơn):**
  - Giữ `src/index.ts`, `src/agent.ts`, `src/tools.ts`, `src/mcp.ts` (và các path thực sự public).
  - Cập nhật test nội bộ sang import domain path mới; xoá shim nội bộ.
  - Source root gần như chỉ còn `index.ts` + 3 facade; nhìn là thấy ngay cây domain.
  - Không đổi behavior CLI; chỉ đổi internal module path. Cần user approve vì có thể ảnh hưởng ai import trực tiếp `dist/`.

> Khuyến nghị: **Option B** nếu package không cam kết public internal modules; **Option A** nếu cần tương thích tuyệt đối.

#### 8.2 Clean-code pass theo domain

Sau khi move (không trộn commit), làm một pass chất lượng riêng cho từng domain:

- Tách function > 150 dòng thành function nhỏ có tên nghiệp vụ.
- Thay > 5 tham số bằng parameter object; bỏ boolean flag khó đọc (`doX(true, false)`).
- Giảm nesting sâu bằng early return; giữ nguyên thứ tự side effect.
- Loại dead code/export không dùng (dùng `tsc`/ESLint + script đối chiếu; không xoá mù).
- Thêm JSDoc ngắn cho public export; ghi rõ invariant/exception.
- Loại `any` mới; với `any` cũ, thay bằng type cụ thể nếu chứng minh được tương đương.
- Chuẩn hoá error handling theo pattern hiện có; **không đổi message/behavior**.

Mỗi pass phải có characterization test trước; nếu không chứng minh được tương đương thì để nguyên và ghi backlog.

#### 8.3 Lint budget chống tái phình

Thêm rule ESLint (có baseline override cho file legacy, sau đó giảm dần về 0):

| Rule | Ngưỡng đề xuất |
|---|---|
| `max-lines` | 400 dòng/file (riêng `agent/run-loop.ts` ≤ 500, `agent/agent.ts` ≤ 450, `tui/app.tsx` ≤ 400) |
| `max-lines-per-function` | 150 |
| `complexity` | 15 |
| `max-depth` | 4 |
| `max-params` | 5 |
| `no-console` | error trong core; off ở `io/`, `cli/`, `ui.ts` |
| `@typescript-eslint/consistent-type-imports` | error |
| `no-floating-promises` | error nếu cấu hình type-aware lint khả thi |

**Cách áp dụng:** bật rule ở mức `warn` + override danh sách file hiện tại; mỗi phase giảm danh sách; Phase 8 kết thúc với allowlist rỗng hoặc có lý do documented. Không bật `max-lines` toàn repo ngay từ Phase 0 vì sẽ đỏ toàn bộ.

#### 8.4 Module charter + graph + orientation

- `src/README.md`: sơ đồ domain, quy tắc layer, "đọc gì trước".
- Mỗi domain `README.md` 10–20 dòng: trách nhiệm, public API, allowed imports, anti-patterns.
- `scripts/check-layers.mjs --graph` sinh Mermaid → `docs/architecture-graph.md`; CI kiểm tra file còn fresh.
- `docs/onboarding.md`: map 10 luồng chính như §5.2.
- **Orientation test:** một người chưa quen repo, chỉ đọc `src/README.md` + domain README + graph, phải trả lời được 10 câu hỏi "luồng X nằm ở đâu" trong ≤ 15 phút. Ghi kết quả vào PR cuối Phase 8.

**Gate:** full test; lint budget pass; graph fresh; root shim đúng chuẩn; orientation test pass; không còn file > ngưỡng ngoại lệ.

**Thời lượng ước tính:** 5–8 ngày (Option A nhanh hơn Option B khoảng 1–2 ngày).

---

### Phase 9 — Docs & hygiene (cập nhật dần trong lúc refactor)

Phase này cập nhật docs ngay khi từng phase code land, tránh tích nợ. **Phase 10 là bước sync toàn bộ lần cuối sau khi code xong.**

- Cập nhật `docs/architecture.md`: module map mới, layer rules, facade policy.
- Cập nhật `docs/testing.md`: `npm test` **không** chạy lint/typecheck; thêm `npm run verify`; giải thích `SCODER_NO_WATCH`.
- Cập nhật `plan/README.md`: số module/test/coverage thực tế, bỏ số liệu cũ.
- Thêm `docs/performance.md`: benchmark baseline, hot path, cache invalidation, performance budget và non-goals.
- Thêm `docs/refactor/decisions.md` (ADR ngắn): facade, move-first, reporter port, performance policy.
- README: sơ đồ module + link refactor plan.
- Kiểm tra `.gitignore` (đã có `.DS_Store`), dọn file rác không tracked nếu có.

**Gate:** docs build/lint không áp dụng; review link; không còn tài liệu nói sai behavior.

**Thời lượng ước tính:** 0,5 ngày.

---

### Phase 10 — Final documentation synchronization (bắt buộc, sau khi code xong)

**Mục tiêu:** sau khi merge code cuối cùng, **toàn bộ tài liệu** phản ánh đúng source, command, config, số liệu test/coverage và kiến trúc mới. Không còn docs mô tả module/flag/route không tồn tại.

**Điều kiện bắt đầu:** tất cả Phase 0–9 đã merge; `main` xanh; không còn PR code đang mở. Phase này **chỉ sửa docs + script kiểm docs**, không sửa behavior.

#### 10.1 Inventory & source-of-truth map

Lập bảng cho **mọi** tài liệu trong repo, ghi rõ nguồn sự thật tương ứng:

| Tài liệu | Source of truth |
|---|---|
| `README.md` | `package.json`, CLI flags, architecture tree, test/coverage thực tế |
| `docs/architecture.md` | cây `src/`, layer rules, `docs/architecture-graph.md` |
| `docs/api.md` | route/SSE trong `server/server.ts`, event schema |
| `docs/commands.md` | `commands/definitions.ts`, `cli/args.ts` |
| `docs/configuration.md` | `config/`, env vars thực tế, `.scoderrc.example.json` |
| `docs/mcp.md` | `mcp/types.ts`, `mcp/manager.ts`, transport behavior |
| `docs/sessions.md` | `session/`, session file format |
| `docs/skills.md` | `context/skills.ts`, skill discovery/format |
| `docs/guardrails.md` | `guardrails.ts`, rule names/thresholds |
| `docs/tui.md` | `tui/`, keybindings, command palette |
| `docs/testing.md` | `package.json` scripts, `test/`, CI workflow |
| `docs/installation.md` | `engines`, `bin`, publish files |
| `docs/README.md` | index/link tới tất cả docs |
| `CHANGELOG.md` | release thực tế; thêm mục refactor, không sửa lịch sử |
| `plan/README.md` | trạng thái plan hiện tại + link `REFACTOR-PLAN.md` |
| `plan/REFACTOR-PLAN.md` | trạng thái từng phase, metrics thực tế, quyết định A/B |
| JSDoc/header trong source | public API, facade `LEGACY PUBLIC PATH`, module charter |
| `.scoderrc.example.json` | schema config thực tế |

Các tài liệu lịch sử `plan/P0-*.md`, `plan/P1-*.md`, `plan/ENTERPRISE-UPGRADE.md` được đánh dấu **ARCHIVED**; không viết lại lịch sử, chỉ sửa link nếu gãy.

#### 10.2 Nội dung phải sync

- **README:** feature list, install/quickstart, CLI flags, architecture diagram, test/coverage numbers, link docs mới.
- **Architecture:** domain tree cuối, layer rules, facade policy, event flow, link graph generated.
- **API:** endpoint list, request/response, auth, SSE event names/schema.
- **Commands:** slash commands + CLI commands + ví dụ; phân biệt REPL/TUI.
- **Configuration:** bảng env vars/rc fields/precedence; đồng bộ `.scoderrc.example.json`.
- **MCP/Skills/Sessions/Guardrails/TUI:** behavior, limitations, config, ví dụ.
- **Testing:** lệnh đúng (`npm run verify`, `npm run coverage`, `SCODER_NO_WATCH`), layout test, coverage thực tế.
- **Installation:** Node version, package name, `scoder` bin, upgrade/uninstall.
- **CHANGELOG:** mục refactor + breaking internal path (nếu Option B); ngày/version đúng.
- **Plan:** đánh dấu phase DONE/PARTIAL, metrics cuối, link ADR.
- **Code comments:** JSDoc public export, module header, facade header, cache invalidation notes.

#### 10.3 Tự động kiểm docs

Thêm `scripts/check-docs.mjs` (không dependency) và chạy trong CI:

1. **Local links:** mọi link Markdown nội bộ phải tồn tại.
2. **Env vars:** extract `SCODER_*` từ `config/` và so với `docs/configuration.md`; thiếu/thừa → fail.
3. **CLI flags:** extract từ `cli/args.ts` và so với README/commands.
4. **Slash commands:** extract từ `commands/definitions.ts` và so với `docs/commands.md`.
5. **HTTP routes:** extract từ `server/server.ts` và so với `docs/api.md`.
6. **Doc inventory:** mọi file trong `docs/*.md` phải có trong `docs/README.md`.
7. **Stale numbers/paths:** grep các pattern cũ (`15 modules`, `104 unit`, `258/258`, `90.28`, `npm test.*lint`, module count cũ) và fail nếu còn.
8. **Code fences:** command trong docs phải chạy được ở chế độ `--help`/dry-run (các lệnh an toàn).

Thêm npm script:
```json
"docs:check": "node scripts/check-docs.mjs"
```
và đưa vào `npm run verify` (hoặc CI job riêng).

#### 10.4 Final audit

- Fresh clone → `npm ci` → `npm run verify` → `npm run docs:check` → `npm pack --dry-run`.
- Chạy các ví dụ CLI trong docs ở temp workdir; so output với mô tả.
- Kiểm tra `docs/README.md` index đủ file.
- Kiểm tra `CHANGELOG.md` có entry cho refactor.
- Kiểm tra `plan/REFACTOR-PLAN.md` status + metrics cuối.
- Review bằng người chưa quen repo: orientation test §5.2 vẫn pass.
- PR cuối chỉ chứa docs/script docs; nếu phát hiện code sai docs → tách PR code riêng, không trộn.

**Gate:**
- `npm run docs:check` pass.
- Không còn stale grep.
- Tất cả link nội bộ valid.
- Ví dụ CLI chạy đúng.
- `npm run verify` pass trên fresh clone.
- Mọi file trong inventory đã review/update hoặc đánh dấu ARCHIVED.

**Thời lượng ước tính:** 1–2 ngày.

---

## 7. Verification matrix

| Kiểm tra | Phase 0 | Mỗi commit move | Mỗi phase | Trước merge |
|---|---:|---:|---:|---:|
| `npm run typecheck` | ✅ | ✅ | ✅ | ✅ |
| `npm run lint` | ✅ | ✅ | ✅ | ✅ |
| Targeted test files | ✅ | ✅ | ✅ | ✅ |
| `SCODER_NO_WATCH=1 npm test` (trước Phase 0 fix) | ✅ |  | ✅ |  |
| `npm test` không env (sau fix) |  |  | ✅ | ✅ |
| `npm run eval` | ✅ |  | ✅ | ✅ |
| `node test/run-e2e.mjs` + `run-mcp-test.mjs` | ✅ |  | ✅ | ✅ |
| Export/facade snapshot | ✅ | ✅ | ✅ | ✅ |
| Architecture guard | ✅ | ✅ | ✅ | ✅ |
| Event/prompt/tool-schema golden | ✅ | ✅ | ✅ | ✅ |
| `npm run coverage` | ✅ |  |  | ✅ |
| Benchmark compare (Phase 6) | baseline |  | ✅ | ✅ |
| Realistic perf budget (Phase 6 P7) | baseline |  | ✅ | ✅ |
| Lint budget `max-lines`/complexity (Phase 8) |  |  | ✅ | ✅ |
| Generated dependency graph fresh (Phase 8) |  |  | ✅ | ✅ |
| Root facade ≤ 20 dòng + header (Phase 8) |  |  | ✅ | ✅ |
| Orientation test 15 phút (Phase 8) |  |  | ✅ | ✅ |
| `npm run docs:check` (Phase 10) |  |  | ✅ | ✅ |
| Local Markdown links valid (Phase 10) |  |  | ✅ | ✅ |
| CLI examples in docs run (Phase 10) |  |  | ✅ | ✅ |
| `npm pack --dry-run` + `node dist/index.js --help` |  |  |  | ✅ |

**Lệnh chuẩn**

```bash
npm ci
npm run lint
npm run typecheck
npm run build
SCODER_NO_WATCH=1 npm test        # tạm thời; sau Phase 0 bỏ env
npm run eval
npm run coverage
node scripts/check-layers.mjs
node scripts/bench.mjs --compare plan/baseline/bench-<sha>.json
npm run docs:check
npm pack --dry-run
node dist/index.js --help
```

---

## 8. Risk register

| Rủi ro | Khả năng | Ảnh hưởng | Giảm thiểu | Rollback |
|---|---|---|---|---|
| Test import `dist/*` gãy do đổi path/export | Cao | Cao | facade + export snapshot + facade test | revert commit |
| Event order/prompt text thay đổi ngoài ý muốn | Trung bình | Cao | golden event/prompt/tool-schema trước khi move | revert phase |
| Tạo circular dependency khi tách agent/tools | Trung bình | Cao | architecture guard + `tsc`; tách types trước | revert bước |
| Move + edit logic trong cùng commit khó review | Cao | Trung bình | move-only commit; `git diff -M`; cấm sửa logic | tách commit |
| Test treo/flaky lại | Trung bình | Cao | dispose/noSave, test timeout, CI timeout | revert test fix |
| Performance cache gây stale data | Trung bình | Cao | chỉ cache có key đầy đủ; benchmark + golden; bug fix riêng | revert perf PR |
| TUI virtualization đổi trải nghiệm scroll | Trung bình | Trung bình | chỉ làm khi user approve; test scroll; có thể bỏ P4 | revert P4 |
| Agent split làm lộ internal API | Trung bình | Trung bình | giữ `private`; delegate public method; review kỹ | revert bước |
| Domain migration tạo diff/import churn lớn | Cao | Trung bình | mỗi domain một PR move-only; facade; `git diff -M` | revert domain PR |
| Option B xoá shim nội bộ làm gãy import ngoài | Thấp | Trung bình | chỉ làm sau khi xác nhận không có consumer; release note; giữ 4 facade chính | khôi phục shim |
| Lint budget gây đỏ hàng loạt | Cao | Thấp | bật `warn` + override baseline; giảm dần theo phase | tắt rule tạm thời |
| Docs/graph bị stale sau thay đổi | Trung bình | Thấp | graph sinh tự động + CI; orientation test cuối phase | cập nhật docs |
| Final docs sync trễ / stale grep | Cao | Thấp | `docs:check` trong CI; inventory map; PR cuối chỉ docs | rerun docs phase |
| Merge conflict do nhiều phase song song | Cao | Thấp | tuần tự từng phase; branch ngắn; rebase thường xuyên | — |
| Coverage giảm do file mới | Thấp | Thấp | coverage không thấp hơn baseline ±0,5%; test theo module | bổ sung test |

---

## 9. Bug tiềm ẩn — **không sửa trong refactor**

Các mục này cần issue/PR riêng, có test tái hiện và quyết định behavior rõ ràng:

| ID | File | Vấn đề | Đề xuất |
|---|---|---|---|
| B1 | `src/tui/at-complete.ts` / `src/file-index.ts` | `cache` toàn cục không key theo `workdir` → workdir B có thể nhận file index của A | key theo workdir + TTL; test 2 workdir |
| B2 | `src/tools.ts` | `MAX_OUTPUT_CHARS` là biến module; `setMaxOutputChars()` của Agent mới ảnh hưởng Agent cũ | chuyển vào `ToolContext`/per-run config |
| B3 | `src/skills.ts` | `skillWarnings` tích luỹ qua nhiều lần `discoverSkills()` → duplicate warnings | reset/trả warnings theo kết quả discover |
| B4 | `src/tui/state.ts` | `applyEvent()` mutate state dù docs ghi pure reducer | hoặc sửa docs, hoặc chuyển immutable có benchmark |
| B5 | `src/tui/state.ts` + `app.tsx` | `visibleWindow()` không được dùng; render tối đa 400 item | cân nhắc P4 sau khi có approval |
| B6 | `docs/testing.md` | Nói `npm test` chạy lint/typecheck nhưng script không chạy | sửa docs (an toàn) hoặc đổi script (cần quyết định) |
| B7 | `test/steer.test.mjs` | Agent không `noSave`/dispose → treo process | **fix trong Phase 0** vì đây là test hygiene, không phải behavior |
| B8 | `src/repo-map.ts` | `repoMapKey()` và `renderRepoMap()` walk repo hai lần | tối ưu P1, không phải bug chức năng |

---

## 10. Acceptance criteria

### Behavior

- [ ] Tất cả characterization/golden tests pass **byte-identical** sau mỗi phase.
- [ ] `AgentEvent` order/schema không đổi; prompt hash không đổi; tool schema không đổi.
- [ ] CLI help/exit code/`parseArgs` không đổi.
- [ ] Permission, config precedence, session format không đổi.
- [ ] Full `npm test` pass **không cần** `SCODER_NO_WATCH=1`.
- [ ] `npm run eval` 11/11 (hoặc ≥ baseline).

### Structure

- [ ] `src/agent.ts` ≤ 120 dòng facade; `agent/agent.ts` ≤ 450 dòng; `agent/run-loop.ts` ≤ 500 dòng (nếu tách); module con ≤ 350 dòng/file. Nếu không tách được run-loop, ghi exception rõ trong PR và không vượt 900 dòng.
- [x] `src/tools.ts` ≤ 120 dòng facade; implementation chia module ≤ 350 dòng/file.
- [x] `src/mcp.ts` ≤ 150 dòng facade; implementation ≤ 350 dòng/file.
- [ ] `src/index.ts` ≤ 80 dòng entry.
- [ ] `src/tui/app.tsx` ≤ 450 dòng (nếu Phase 5 hoàn tất).
- [ ] Root `src/` chỉ còn entry + facade; mỗi facade ≤ 20 dòng, có header `LEGACY PUBLIC PATH` (Option A) hoặc đã xoá theo Option B.
- [ ] Có cây domain rõ ràng: `agent/`, `tools/`, `mcp/`, `llm/`, `context/`, `workspace/`, `security/`, `session/`, `config/`, `io/`, `cli/`, `tui/`, `shared/`.
- [ ] Mỗi domain có `README.md` mô tả trách nhiệm/allowed imports/public API.
- [ ] `docs/architecture-graph.md` sinh tự động và CI kiểm tra freshness.
- [ ] `docs/onboarding.md` map 10 luồng chính; orientation test ≤ 15 phút pass.
- [ ] Không còn runtime cycle; không còn type-only cycle `tools ↔ webfetch`.
- [ ] `check-layers` pass; allowlist rỗng (trừ quyết định documented).
- [ ] Mọi path cũ trong Compatibility contract vẫn import được (Option A) hoặc danh sách public path đã chốt (Option B).

### Quality

- [ ] Lint/typecheck/build sạch.
- [ ] Lint budget Phase 8 pass: `max-lines`, `max-lines-per-function`, `complexity`, `max-depth`, `max-params`, `no-console` core.
- [ ] Không tăng số `any`/non-null assertion so với baseline (đếm bằng script hoặc ESLint).
- [ ] Không còn export dead code trong domain public API (đối chiếu script/tsc).
- [ ] Coverage không thấp hơn baseline quá 0,5 điểm phần trăm.
- [ ] Không thêm dependency runtime.
- [ ] `npm pack --dry-run` không chứa file lạ; `dist` layout cũ vẫn tồn tại.
- [ ] Docs architecture/testing/plan/onboarding được cập nhật.

### Performance (Phase 6)

- [ ] `buildRepoMap` cold nhanh hơn ≥20% hoặc có lý do rõ ràng để bỏ.
- [ ] `buildEnvInfo` lặp lại trong run ~0 ms.
- [ ] `findSkill`/skills index nhanh hơn ≥50% trong run (nếu làm P3).
- [ ] Realistic benchmark (repo 5.000 file, 100 skill, TUI 400 item) đạt budget đã chốt.
- [ ] Không benchmark nào chậm hơn >5%.
- [ ] Output repo map/prompt giống hệt baseline.

### Documentation (Phase 10)

- [ ] `npm run docs:check` pass.
- [ ] Mọi file trong `docs/*.md` đều có trong `docs/README.md`.
- [ ] Không còn stale terms/numbers/path trong docs (`check-docs`).
- [ ] Tất cả link Markdown nội bộ valid.
- [ ] Ví dụ CLI trong docs chạy đúng ở temp workdir.
- [ ] Env vars, CLI flags, slash commands, HTTP routes trong docs khớp source.
- [ ] `CHANGELOG.md` có mục refactor + breaking internal path (nếu Option B).
- [ ] `plan/REFACTOR-PLAN.md` trạng thái/metrics cuối được cập nhật; historical docs đánh dấu ARCHIVED.
- [ ] JSDoc/header public module và facade header đầy đủ.

---

## 11. Thứ tự thực thi & chiến lược commit

1. Phase 0 (safety net) — **bắt buộc** trước mọi move.
2. Phase 1 (layering) — ít rủi ro, mở đường cho split.
3. Phase 2 (tools) — độc lập, dễ review.
4. Phase 3 (mcp) — độc lập.
5. Phase 4 (agent) — rủi ro cao, làm khi các phase trước ổn định.
6. Phase 5 (CLI/TUI) — sau agent.
7. Phase 6 (perf) — chỉ sau khi cấu trúc ổn định.
8. Phase 7 (provider dedup) — optional, tách epic.
9. Phase 8 (domain migration + clean-code hardening) — khuyến nghị mạnh; chốt Option A/B trước khi bắt đầu.
10. Phase 9 (docs) — cuối, hoặc cập nhật dần theo phase.
11. Phase 10 (final docs sync) — **bắt buộc**, sau khi code xong; không sửa behavior.

**Quy ước commit**

```
refactor(layers): move image helpers out of tui (no behavior change)
refactor(tools): extract read/list file tools (move-only)
refactor(tools): extract search tools (move-only)
refactor(mcp): extract SSE parser (move-only)
refactor(agent): extract verification subsystem (move-only)
refactor(context): move prompt/repo-map/memory into context/ (move-only)
refactor(security): move permission/sandbox into security/ (move-only)
style(agent): split long functions and add parameter objects (no behavior change)
chore(lint): enforce max-lines/complexity budgets
perf(repo-map): single walk for key + render
test(contracts): add export and event golden snapshots
docs(architecture): document layering and facades
```

- Mỗi commit phải build + targeted tests pass.
- Commit move-only không sửa logic; nếu cần sửa compile do import, sửa tối thiểu.
- Dùng `git diff -M --stat` để review rename; `git log --follow` cho file đã move.
- PR nhỏ (~400–800 dòng move/PR); không gộp nhiều subsystem.
- Không dùng feature flag cho refactor thuần; rollback = revert commit/PR.

**Ước lượng tổng:** ~23–36 ngày người, chưa gồm Phase 7 optional.

---

## 12. Quyết định cần user xác nhận

1. **Domain migration (Phase 8):** làm đầy đủ cho toàn bộ core, hay chỉ dừng ở 4 file lớn? Nếu mục tiêu là "nhìn source thấy ngay kiến trúc", nên làm đầy đủ.
2. **Facade policy (Phase 8):** Option A (giữ toàn bộ path cũ, an toàn) hay Option B (chỉ giữ public facade, source sạch hơn)? Cần biết có consumer nào import trực tiếp `dist/<module>.js` không.
3. **TUI virtualization (P4):** có được phép thay đổi cách render ngoài viewport không? Nếu ưu tiên tuyệt đối "không đổi behavior", bỏ P4.
4. **Output reporter port (Phase 1.4):** có muốn làm ngay hay chấp nhận `core → ui.ts` như tech debt có kiểm soát?
5. **Agent run-loop split (Phase 4.8):** nếu risk vượt ngưỡng, có chấp nhận dừng ở `agent.ts` ~1.000 dòng thay vì ép ≤900?
6. **Lint budget (Phase 8.3):** chấp nhận `max-lines` 400/500 và complexity 15, hay muốn nới để giảm churn?
7. **Phase 7 provider dedup:** làm trong đợt này hay để backlog?
8. **Coverage ngưỡng:** giữ baseline hay đặt ngưỡng tối thiểu mới (ví dụ 85% line)?
9. **Performance budget (Phase 6 P7):** chấp nhận baseline +10% làm ngưỡng CI, hay chỉ đo report không chặn merge?
10. **Docs check (Phase 10):** fail CI khi docs stale, hay chỉ report để sửa dần? Nếu mục tiêu là "tài liệu luôn latest", nên fail CI.

---

## 13. Kết luận ngắn

**Câu trả lời thẳng:** nếu chỉ hoàn thành Phase 0–7, source sẽ gọn và an toàn hơn, nhưng **chưa đủ để nhìn vào là thấy ngay kiến trúc**. Muốn đạt tiêu chí đó phải làm thêm **Phase 8** (domain migration + module charter + lint budget + graph + orientation), **P7** (benchmark workload thật), và **Phase 10** (sync toàn bộ docs sau khi code xong).

Thứ tự đúng vẫn là **Phase 0 trước**: hiện test suite chưa tự kết thúc trong điều kiện bình thường, nên mọi refactor lớn lúc này đều thiếu lưới an toàn. Sau khi có characterization tests + architecture guard + benchmark baseline, thứ tự move-first `tools → mcp → agent → cli/tui → domain migration → docs sync` sẽ giảm rủi ro và giữ tương thích với test import `dist/*.js`.

Không nên bắt đầu bằng việc tách `agent.ts` — đó là file phụ thuộc nhiều nhất và dễ gây drift event order nhất. Hãy để nó sau cùng, khi các module lá đã ổn định và facade pattern đã được chứng minh.
