# Sessions & Persistence

Every run auto-saves its state to `.scoder/sessions/` after each step. If interrupted, you can resume where you left off.

## Session Files

```
<workdir>/.scoder/sessions/<id>.json     — v1 snapshot (legacy)
<workdir>/.scoder/sessions/<id>/        — v2 event log
  ├── events.jsonl                       — durable event log
  └── manifest.json                      — projection summary
```

## Commands

```bash
scoder list                      # list saved sessions
scoder resume last               # continue most recent session
scoder resume <id>               # resume specific session
scoder resume last "follow-up"   # resume + add new instruction
```

## Session Pruning

- Completed sessions older than 7 days are auto-deleted
- Failed/incomplete sessions are kept for resume
- Malformed session files are pruned immediately

Disable auto-save (e.g., in CI):
```bash
scoder --no-save "run the migration"
```

## JSONL Logs

Enable structured event logging:

```bash
scoder --log-file "fix the bug"
# Logs to .scoder/logs/<session-id>.jsonl

# View logs
scoder logs <id|last>
scoder logs last "error"

# Or pipe to jq
cat .scoder/logs/<id>.jsonl | jq 'select(.type == "error")'
```

## Event Types in JSONL

| Type | Description |
|------|-------------|
| `run.started` | Session started |
| `step` | Step completed (duration, tool count) |
| `tool` | Tool execution (args, ok, elapsedMs) |
| `build` | Build result |
| `guardrail` | Guardrail decision |
| `prompt_version` | System prompt version stamp |
| `llm_usage` | Token usage per call |
| `compaction.ran` | History summarization |
| `finish` | Run completion |

## Cost Tracking

Read token usage from JSONL logs:

```bash
scoder cost                        # all sessions
scoder cost --last 5               # 5 most recent
scoder cost --session <id>         # specific session
```

Output:
```
  20261031-110353  calls=1  in=4,042  out=88  cost≈$0.0022  |  steps=1  ✓success
TOTAL (1 session(s))  ...  |  success-rate=1/1
```