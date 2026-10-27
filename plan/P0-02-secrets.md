# P0.2 — Secrets Hygiene

## Mục tiêu

Ngăn API key bị commit lên GitHub, giúp người dùng dùng tool mà không lo exposure key.

## Phân tích vấn đề

Hiện tại `.coderrc.json` có thể chứa `"apiKey": "sk-..."`. Đây là pattern rất dễ nhầm commit:

```bash
echo '{"apiKey": "sk-xxx"}' > .coderrc.json
git add .coderrc.json  # 😱
```

## Thiết kế

### 1. Cảnh báo khi load apiKey từ rc file

Trong `config.ts`, sau khi parse rc file và thấy có `apiKey`:

```ts
if (rc.apiKey) {
  // Warn to stderr only — do not fail for backward compat
  console.warn(
    "\n⚠  WARNING: .coderrc.json contains apiKey.\n" +
    "   This file should NOT be committed to version control.\n" +
    "   Use environment variable CODER_API_KEY instead.\n" +
    "   (This warning can be suppressed with CODER_NO_APIKEY_WARNING=1)\n"
  );
}
```

### 2. Tạo `.coderrc.example.json`

Tạo file mới trong project root (cùng thư mục với `.coderrc.json` mẫu):

```json
{
  "model": "gpt-4o-mini",
  "baseUrl": "https://api.openai.com/v1",
  "buildCmd": null,
  "maxSteps": 40,
  "permissions": {
    "mode": "auto",
    "allowCommands": ["npm ", "git ", "npx ", "pnpm ", "make ", "cargo "],
    "denyCommands": ["curl ", "wget "]
  }
}
```

### 3. Kiểm tra git pre-commit (optional)

File `scripts/check-secrets.mjs` (standalone, không phải dependency):

```js
// Kiểm tra xem .coderrc.json có bị staged với apiKey trong đó không
// Chạy: node scripts/check-secrets.mjs
// Hook git: npx husky add .husky/pre-commit "node scripts/check-secrets.mjs"
```

### 4. Update .gitignore

Thêm:
```
# coder-agent
.coder/
.coder-sessions/
```

### 5. Redact trong error messages

Trong `llm.ts`, nếu API trả về lỗi 401/403, redact Authorization header khỏi error message:

```ts
if (!res.ok) {
  const body = await res.text().catch(() => "");
  const safeBody = body.replace(/Bearer [^&\s]+/g, "Bearer ***REDACTED***");
  throw new LlmError(`LLM API error ${res.status}: ${safeBody.slice(0, 500)}`);
}
```

## File changes

| File | Thay đổi |
|---|---|
| `src/config.ts` | Thêm cảnh báo stderr khi rc.apiKey có giá trị |
| `src/llm.ts` | Redact Bearer token trong error messages |
| `.coderrc.example.json` | **NEW** — mẫu config không có apiKey |
| `scripts/check-secrets.mjs` | **NEW** — pre-commit hook kiểm tra staging apiKey |
| `.gitignore` | Cập nhật: thêm .coder/ |
| `README.md` | Thêm Security section |

## Acceptance criteria

1. `coder --help` hiển thị Security section rõ ràng
2. Config có apiKey → cảnh báo in ra stderr (không fail)
3. Error 401/403 không leak Bearer token trong message
4. `.coderrc.example.json` tồn tại và không có apiKey
5. `scripts/check-secrets.mjs` exit 1 nếu phát hiện apiKey trong staged files
6. `.gitignore` đúng
