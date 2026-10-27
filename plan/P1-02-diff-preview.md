# P1.2 — Diff Preview trước khi ghi file

## Mục tiêu

Người dùng thấy agent sắp thay đổi gì **trước khi** thay đổi được ghi vào disk — như Cline/Claude Code.

## Thiết kế

### 1. Sinh unified diff trước khi ghi

File mới `src/diff.ts`:

```ts
export function unifiedDiff(
  path: string,
  oldContent: string | null,   // null = file mới
  newContent: string,
): string
```

- Tự implement Myer's diff đơn giản (hoặc LCS-based, đủ tốt cho file < 2000 dòng) — **không thêm dependency**
- Format chuẩn unified diff `--- a/path\n+++ b/path\n@@ -l,c +l,c @@`
- Giới hạn hiển thị: tối đa ~60 hunk lines; lớn hơn thì hiện tóm tắt "+X -Y lines changed"

### 2. Khi nào hiện diff

| Mode | write_file / edit_file |
|---|---|
| `auto` | Chạy ngay, in summary `+12 -3 lines → src/foo.ts` sau khi ghi |
| `ask` | In diff → prompt `[y]es / [n]o / [a]lways (session)` trước khi ghi |
| `readonly` | In diff nhưng KHÔNG ghi, trả kết quả cho LLM "denied in readonly mode" |

### 3. Hook vào tools.ts

- `write_file`: đọc nội dung cũ (nếu file tồn tại) → diff → (prompt nếu ask) → ghi
- `edit_file`: đọc file → áp replace trong memory → diff giữa old và new → (prompt) → ghi
- Refusal (n) → trả tool result lỗi: `"User rejected the edit to <path>."` → LLM tự điều chỉnh

### 4. UI

```
✎ edit src/agent.ts
  -   const x = compute(a);
  +   const x = compute(a, opts);
[y]es [n]o [a]lways:
```

## File changes

| File | Thay đổi |
|---|---|
| `src/diff.ts` | **NEW** — unifiedDiff() |
| `src/tools.ts` | write/edit file gọi diff + permission hook trước khi ghi |
| `src/ui.ts` | In diff với màu (green +, red -) |
| `src/permissions.ts` | Mở rộng: confirmAction() dùng chung cho cả run_command và file writes |

## Acceptance criteria

1. Mode ask: mỗi write/edit hiện diff và chờ confirm
2. Chọn `a` → các edit tiếp theo trong session không hỏi lại
3. Chọn `n` → LLM nhận lỗi, thử cách khác
4. Mode auto: hành vi như cũ, chỉ thêm summary line `+12 -3 lines → src/foo.ts`
5. Diff render đúng với file mới (toàn bộ là +) và file bị xóa nội dung
