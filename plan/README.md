# Roadmap: coder-agent → production-ready CLI

> Trạng thái tổng thể được cập nhật ở file này. Chi tiết từng hạng mục nằm trong file riêng.

## Nguyên tắc

1. **Mỗi phase là một milestone độc lập** — xong là dùng được, không để code dở.
2. **Không phá vỡ triết lý hiện tại**: 0 runtime dependencies, Node built-ins only.
3. **Mọi thay đổi phải pass**: `npm run typecheck` + `npm test` (e2e với mock LLM).
4. **Backward compatible**: `.coderrc.json` cũ vẫn chạy; hành vi mặc định chỉ thay đổi khi có lý do bảo mật.

## Tổng quan tiến độ

| # | Phase | File kế hoạch | Trạng thái |
|---|---|---|---|
| P0.1 | Permission & Safety system | [P0-01-permissions.md](./P0-01-permissions.md) | ✅ DONE |
| P0.2 | Secrets hygiene | [P0-02-secrets.md](./P0-02-secrets.md) | ✅ DONE |
| P0.3 | Streaming output | [P0-03-streaming.md](./P0-03-streaming.md) | ✅ DONE |
| P0.4 | Provider layer (Anthropic + retry) | [P0-04-providers.md](./P0-04-providers.md) | ✅ DONE (retry + Anthropic; Anthropic streaming để P2) |
| P0.5 | Session persistence & resume | [P0-05-sessions.md](./P0-05-sessions.md) | ✅ DONE |
| P1.1 | MCP client support | [P1-01-mcp.md](./P1-01-mcp.md) | ✅ DONE |
| P1.2 | Diff preview trước khi ghi file | [P1-02-diff-preview.md](./P1-02-diff-preview.md) | ✅ DONE |
| P1.3 | GitHub Actions CI | [P1-03-ci.md](./P1-03-ci.md) | ✅ DONE |
| P1.4 | Structured logging (JSONL) | [P1-04-logging.md](./P1-04-logging.md) | ✅ DONE |

## Định nghĩa "done" cho từng mức

### Sau P0 (MVP dùng được thật)
- Người lạ clone repo về, đọc README 5 phút, chạy được task thật mà không sợ tool phá máy.
- Agent treo không còn "màn hình đứng yên" — thấy token stream ra.
- Task fail bước 39/40 vẫn resume được.
- Điểm tự đánh giá: **3/10 → ~6/10** so với OpenCode/Cline/Claude.

### Sau P1 (repo có cộng đồng)
- MCP support, diff preview, CI badge, log file để debug.
- Điểm: **~6.5–7/10**.

## Ngoài phạm vi (có chủ đích)

Các mục enterprise sau **không làm** ở giai đoạn này vì thiếu server component + user model:

- AuthN/AuthZ, RBAC, multi-tenancy
- Audit log compliance (SOC2/GDPR)
- Observability (OTel), rate limiting server-side
- Secrets vault integration

Chỉ quay lại khi chuyển hướng thành sản phẩm SaaS (xem `ENTERPRISE.md` nếu tạo sau này).
