# P0.5 — Session Persistence & Resume

## Mục tiêu

Lưu toàn bộ trạng thái agent (messages, task, bước) vào disk sau mỗi bước. Task fail ở bước 39/40 vẫn có thể resume tiếp.

## Phân tích vấn đề

Hiện tại messages chỉ nằm trong memory (`agent.ts: this.messages`). Task fail (max steps, SIGINT, crash) → mất toàn bộ tiến trình, agent phải bắt đầu lại từ đầu (tốn tiền + thời gian).

## Thiết kế

### 1. Session file format

Lưu tại `<workdir>/.coder/sessions/<id>.json`:

```json
{
  "id": "20261027-143522-a1b2",
  "createdAt": "2026-10-27T14:35:22.000Z",
  "updatedAt": "...",
  "task": "fix the null pointer in UserService",
  "model": "gpt-4o-mini",
  "buildCmd": "npm run build",
  "steps": 12,
  "messages": [ ... ChatMessage[] ... ],
  "lastBuild": { "success": false, "command": "npm run build", "output": "..." }
}
```

- ID format: `YYYYMMDD-HHmmss-<4 hex ngẫu nhiên>` — sort theo tên = sort theo thời gian
- Thư mục `.coder/` trong workdir, thêm vào `.gitignore`

### 2. Auto-save

- Sau **mỗi step** (mỗi vòng loop trong `agent.ts`) → ghi file (atomic: ghi `.tmp` rồi rename)
- Ghi đè cùng file trong 1 session, không tạo file mới mỗi bước
- Ghi cả khi abort (SIGINT) — đây là case quan trọng nhất

### 3. CLI commands

```
coder list                      # liệt kê sessions của workdir hiện tại
coder resume <id>               # resume session (tiếp tục loop)
coder resume last               # resume session mới nhất
coder resume <id> "<follow-up>" # resume + thêm task mới vào session
```

Resume flow:
1. Load JSON → khôi phục `messages`, `steps` (đếm tiếp lên maxSteps tổng)
2. Build lại LlmClient, ToolContext từ config hiện tại
3. Tiếp tục vòng loop như bình thường

### 4. REPL integration

Trong REPL, mỗi input là một "turn" trong cùng session (không tạo session mới mỗi line). Session REPL lưu liên tục, Ctrl+D → save lần cuối rồi thoát.

### 5. Dọn dẹp

- Session file > 7 ngày và success → xóa tự động khi `coder list` chạy (kèm log)
- `--no-save` flag để tắt auto-save (script CI không muốn sinh rác)

## File changes

| File | Thay đổi |
|---|---|
| `src/session.ts` | **NEW** — SessionStore: save/load/list/prune, id generation |
| `src/agent.ts` | Gọi `sessionStore.save()` sau mỗi step + khi abort; nhận initial messages từ resume |
| `src/index.ts` | Subcommands `list`, `resume`; flag `--no-save` |
| `src/config.ts` | (không đổi nhiều) |
| `.gitignore` | Thêm `.coder/` |

## Acceptance criteria

1. Chạy task → `.coder/sessions/<id>.json` được tạo và cập nhật sau mỗi step
2. `coder list` hiện danh sách session (id, task ngắn, steps, time, success/fail)
3. Task bị Ctrl+C giữa chừng → `coder resume last` tiếp tục từ chỗ dừng (messages còn nguyên)
4. `coder resume <id> "thêm feature X"` → context cũ + task mới
5. `.coder/` nằm trong .gitignore — không bao giờ commit
6. E2E: chạy mock task, kill giữa chừng, resume → agent biết task cũ và tiếp tục
