# Plan — app-coding-agent

> Kế hoạch nâng cấp chuẩn enterprise — cập nhật: 28/10/2026 (Enterprise hardening session #2)

## Tổng quan

`coder` — Autonomous coding agent CLI (giống opencode/cline/Claude Code):
LLM lập kế hoạch → tools thực thi → build → loop đến khi build pass.
15 modules TypeScript, 0 runtime deps, 57 unit tests + e2e + MCP smoke tests.

## Đánh giá ban đầu

| Hạng mục | Điểm | Ghi chú |
|----------|------|---------|
| Kiến trúc | 9/10 | Modules tách sạch (agent/llm/tools/permissions/mcp) |
| Bảo mật | 8/10 | Permission 3-mode + catastrophic deny — nhưng có lỗ hổng regex |
| Reliability | 7/10 | Timeout prompt không hoạt động |
| Testing | 5/10 | Chỉ e2e, không có unit test cho permissions |
| TypeScript | 10/10 | typecheck sạch |

## Đánh giá sau Enterprise Hardening (28/10/2026)

| Hạng mục | Trước | Sau | Ghi chú |
|----------|-------|-----|---------|
| Kiến trúc | 9/10 | 9/10 | Modules tách sạch, giữ nguyên |
| Bảo mật | 8/10 | 9.5/10 | Symlink-safe paths, word-boundary allowlist, redact sk-*, request timeout |
| Reliability | 7/10 | 9.5/10 | SIGINT cancel in-flight, no hang on timeout, no premature exit |
| Testing | 5/10 | 8/10 | 57 unit tests (permissions 29 + tools 10 + core 18) + e2e + MCP |
| TypeScript | 10/10 | 10/10 | typecheck sạch |

## Vấn đề phát hiện & đã sửa (28/10/2026)

### BUG-1: Timeout của permission prompt không bao giờ thực thi (Critical) — ĐÃ FIX
- **File:** `src/permissions.ts` → `promptForPermission()`
- **Triệu chứng:** UI hiển thị "timeout in 60s" đếm ngược, nhưng `rl.question()`
  chờ vô hạn — deadline chỉ dùng để hiển thị, không có cơ chế abort.
- **Fix:** dùng `AbortController` + `setTimeout` + `signal` cho readline.
  Timeout → tự động **deny** (an toàn hơn allow), `finally` dọn timer + close rl.

### BUG-2: Regex catastrophic bỏ sót dạng phổ biến nhất của pipe-to-shell (High) — ĐÃ FIX
- **File:** `src/permissions.ts` → `CATASTROPHIC_PATTERNS`
- **Fix:** `/curl\s+.*[/.].*\s*\|\s*sh\b/i` + biến thể `| bash`.

### BUG-3: Dead code `void isAnth` (Minor) — ĐÃ FIX
- **File:** `src/config.ts` — biến không dùng, đã xóa.

### TEST-1: Thiếu unit test cho module bảo mật (High) — ĐÃ FIX
- 27→29 assertions trong `test/permissions.test.mjs`.

### BUG-4: promptForPermission treo vĩnh viễn khi timeout (Critical) — ĐÃ FIX (session 2)
- **Phân tích:** Node's `rl.question()` callback **không bao giờ được gọi** khi
  interface bị đóng qua aborted signal → promise không bao giờ settle → hang.
  Fix cũ (BUG-1) chỉ đúng một nửa: có AbortController nhưng promise vẫn treo.
- **Fix:** `Promise.race([question(prompt), aborted])` — aborted là promise
  reject khi signal abort. Timeout giờ **thật sự** deny trong ~timeoutSecs.
- **Test mới:** `timeout: promptForPermission tự deny khi hết hạn (không treo)`.

### BUG-5: SessionAllowlist match sai ranh giới từ (High) — ĐÃ FIX (session 2)
- `addPrefix("git ")` bị strip trailing space → thành `"git"` → khớp cả
  `gitx-evil`, `github-cli`... Allow "git " phải chỉ cho phép lệnh `git`.
- **Fix:** normalize thành `"git "` (word boundary). Test cũ assert hành vi
  buggy ("gitx cũng khớp") đã được sửa lại để assert hành vi AN TOÀN.

### BUG-6: Premature build detection — agent dừng giữa task (Critical) — ĐÃ FIX (session 2)
- `agent.ts`: `tc.arguments.includes(buildCmd.split(" ")[0])` → chỉ match từ
  đầu tiên ("npm"). Agent chạy `npm install` giữa task → nếu build đang pass,
  agent **dừng prematurely** với trạng thái "task complete".
- **Fix:** match **full** buildCmd trong arguments.

### BUG-7: stop_reason operator precedence (High) — ĐÃ FIX (session 2)
- `choice.stop_reason ?? choice.content ? "stop" : undefined` — `??` bind
  chặt hơn `?:` nên thành `(stop_reason ?? content) ? "stop" : undefined`.
  stop_reason thực tế bị bỏ hoàn toàn.
- **Fix:** `choice.stop_reason ?? (choice.content ? "stop" : undefined)`.

### BUG-8: Không có request timeout cho LLM calls (High) — ĐÃ FIX (session 2)
- Fetch LLM không có signal/timeout → connection treo = agent chết vĩnh viễn.
- **Fix:** `combinedSignal(external, timeoutMs)` — 120s timeout mặc định +
  external AbortSignal cho SIGINT. Node ≥18 compatible (không dùng
  AbortSignal.any).

### BUG-9: SIGINT không cancel in-flight LLM request (Medium) — ĐÃ FIX (session 2)
- **Fix:** Agent giữ `runSignal: AbortController`; `abort()` abort signal →
  fetch request bị cancel ngay; runLoop catch abort → dừng graceful.
- `chatWithStream` khi aborted → trả stub message, loop break, save session.

### BUG-10: safePath không resolve symlink (High) — ĐÃ FIX (session 2)
- LLM có thể tạo symlink trong workdir trỏ ra ngoài (vd `evil-link -> /etc`)
  rồi ghi file qua symlink → **ghi ra ngoài workdir**.
- **Fix:** `realpathSync` trên file (hoặc nearest existing ancestor nếu file
  chưa tồn tại) trước khi check containment. Resolve cả workdir qua realpath
  (macOS `/tmp` → `/private/tmp`).

### BUG-11: diff over-count trailing newline (Medium) — ĐÃ FIX (session 2)
- `unifiedDiff`/`diffCounts` dùng `split("\n")` thô trong khi helper
  `splitLines()` (drop trailing empty) tồn tại nhưng **không được gọi**.
  Mỗi diff có trailing newline đếm thừa 1 dòng.
- **Fix:** dùng `splitLines()` ở cả 2 hàm.

### BUG-12: Tools throw thay vì trả structured error (Medium) — ĐÃ FIX (session 2)
- `safePath` throw → agent.ts phải try/catch; tests phải bắt throw.
- **Fix:** tools trả `{ok: false, output: "ERROR: ..."}` — nhất quán với
  ToolResult contract.

### BUG-13: read_file đọc file bất kỳ kích thước vào memory (Medium) — ĐÃ FIX (session 2)
- **Fix:** cap 2MB, trả error với gợi ý dùng grep/head/tail.

### BUG-14: confirmEdit không timeout + process.exit(130) giữa library (Medium) — ĐÃ FIX (session 2)
- **Fix:** timeout 120s (safe-deny), `[q]uit` set `abortRequested` flag thay
  vì kill process từ library code.

### BUG-15: MAX_DIFF_TEXT_LINES dead code (Medium) — ĐÃ FIX (session 2)
- Hằng số 120 dòng được khai báo nhưng không được enforce → diff 2000 dòng
  vẫn render đầy đủ. **Fix:** cap render + summary khi vượt.

### BUG-16: Double-build execution (Medium) — ĐÃ FIX (session 2)
- Khi agent tự chạy build command, agent lại chạy checkBuild() lần nữa
  (build chạy 2 lần/step). **Fix:** reuse tool result của chính call đó.

### BUG-17: Stream body không cancel (Low) — ĐÃ FIX (session 2)
- `streamChat` finally chỉ `releaseLock()`, không cancel body → socket treo
  đến khi GC. **Fix:** `reader.cancel()` trong finally.

### BUG-18: Secrets trong error body (Medium) — ĐÃ FIX (session 2)
- `toLlmError` chỉ redact `Bearer ...`. **Fix:** thêm redact `sk-*` raw keys.

## Kiểm chứng

```
npm run typecheck  →  0 errors
npm test           →  57/57 unit tests pass + e2e closed-loop + MCP smoke
  test/permissions.test.mjs  →  29 tests (catastrophic patterns, classify, allowlist word-boundary, timeout-denies)
  test/tools.test.mjs        →  10 tests (safePath traversal + symlink escape, size cap, write/edit/list)
  test/core.test.mjs         →  18 tests (diff, retry, context)
```

## Backlog đề xuất (P1/P2)

- [ ] REPL dùng chung 1 session cho cả conversation (hiện mỗi line tạo Agent mới)
- [ ] Anthropic native streaming (content_block_delta) — hiện fallback non-streaming
- [ ] `pruneSessions` chỉ xóa session success (hiện xóa mọi session > 7 ngày)
- [ ] ESLint + Prettier pipeline
- [ ] Soften `checkBuild` chạy build mà không qua permission gate (design decision — cần document)
- [ ] MCP: HTTP/SSE transport (P2)
- [ ] Log viewer CLI: `coder logs <id>`

## Lịch sử commit (Enterprise hardening session 2)

1. `fix(security)`: critical permission-prompt hang, premature build exit, SIGINT cancel, request timeout
2. `fix(reliability)`: symlink-safe paths, file-size cap, diff render cap, double-build optimization
3. `test(core)`: +18 unit tests; fix trailing-newline diff bug

