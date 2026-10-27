# P1.4 — Structured Session Logging (JSONL)

## Mục tiêu

Ghi log session ra file JSONL để debug khi agent hành xử lạ, không phải chỉ nhìn stdout tạm thời.

## Thiết kế

### 1. Log file format

```
<workdir>/.coder/logs/<session-id>.jsonl

{"type":"step","step":1,"ts":"2026-10-27T14:35:22.001Z","llm":{"model":"gpt-4o-mini","usage":{"prompt_tokens":1200,"completion_tokens":340}}}
{"type":"tool","step":1,"ts":"2026-10-27T14:35:23.100Z","tool":"read_file","args":{"path":"src/agent.ts"},"ok":true,"elapsedMs":12}
{"type":"tool","step":1,"ts":"2026-10-27T14:35:23.500Z","tool":"run_command","args":{"command":"npm run build"},"ok":false,"output":"..."}
{"type":"build","step":2,"ts":"2026-10-27T14:35:30.000Z","success":false,"output":"..."}
{"type":"error","step":5,"ts":"2026-10-27T14:35:40.000Z","message":"LLM API error 429: rate limit"}
{"type":"retry","step":5,"ts":"2026-10-27T14:35:42.000Z","attempt":1,"delayMs":2100}
{"type":"finish","ts":"2026-10-27T14:36:00.000Z","success":true,"steps":12}
```

- 1 JSONL line = 1 event, có thể parse bằng `jq` hoặc bất kỳ log consumer nào
- `session-id` = same ID as session file in `.coder/sessions/`

### 2. Config

```ts
interface LoggingConfig {
  logFile: boolean | string;  // true = auto (.coder/logs/<id>.jsonl), false = none, string = path
}
```

- CLI: `--log-file[=<path>]`
- Env: `CODER_LOG_FILE=1` hoặc `CODER_LOG_FILE=/var/log/coder-agent.jsonl`

### 3. Log levels

Chỉ 1 level cho phase này (simple): mọi event quan trọng đều log. Sau này có thể thêm `CODER_LOG_LEVEL=warn|info|debug`.

### 4. Implementation

- File mới `src/logger.ts`: `Logger` class, ghi line-by-line vào file (append, không flush mỗi line — OS buffer OK)
- Thêm `Logger` instance vào `Agent.run()`, truyền vào các class cần log
- Thêm `"log"` vào `.gitignore` (hoặc `.coder/logs/`)
- Cảnh báo nếu log file không ghi được (disk full, perm) → warn chứ không crash

### 5. Log viewer CLI (optional, P2)

```bash
coder logs <session-id>        # cat session log
coder logs --tail <session-id>  # tail -f
coder logs --filter error       # jq filter
```

## File changes

| File | Thay đổi |
|---|---|
| `src/logger.ts` | **NEW** — Logger class, JSONL write |
| `src/agent.ts` | Emit log events |
| `src/llm.ts` | Log API errors + retry attempts |
| `src/index.ts` | Flag `--log-file[=<path>]` |
| `README.md` | Thêm Logging section |

## Acceptance criteria

1. `coder --log-file "task"` → `.coder/logs/<id>.jsonl` được tạo với đúng format JSONL
2. Mỗi step có event `step`, mỗi tool call có `tool`, mỗi build có `build`, finish có `finish`
3. Retry attempt được log với delayMs
4. Log file parse được bằng `cat <log> | jq '.type == "error"'`
5. Không ảnh hưởng hiệu năng đáng kể (append-only, OS-buffered write)
