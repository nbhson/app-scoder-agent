# Testing

## Run Tests

```bash
npm test          # full pipeline: lint → typecheck → build → tests
npm run lint      # ESLint flat config
npm run typecheck # tsc --noEmit
npm run build     # tsc
npm run coverage  # build + coverage report
```

## Test Suites

Tests are auto-discovered via `test/*.test.mjs`:

| File | Coverage |
|------|----------|
| `test/permissions.test.mjs` | Catastrophic patterns, mode classification, allowlist word-boundary |
| `test/permission-prompt.test.mjs` | Interactive prompt timeout |
| `test/tools.test.mjs` | safePath, symlink escape, file-size cap, write/edit/list |
| `test/webfetch.test.mjs` | HTML→text, JSON, redirects, SSRF guard, binary refusal |
| `test/server.test.mjs` | HTTP API: run lifecycle, abort, auth |
| `test/tui.test.mjs` | Full-screen TUI in real PTY |
| `test/tui-state.test.mjs` | Event reducer unit tests |
| `test/review-flow.test.mjs` | /review prompt-gate wiring |
| `test/core.test.mjs` | Diff, retry, context trimming, @file mentions |
| `test/config.test.mjs` | Env/rc/cli precedence, logFile mapping |
| `test/session.test.mjs` | Session store, prune, resolve |
| `test/cost.test.mjs` | Token usage & cost aggregation |
| `test/guardrails.test.mjs` | Guardrail Engine: rule registry, thresholds |
| `test/prompt.test.mjs` | System prompt versioning |
| `test/anthropic.test.mjs` | Message translation + native SSE streaming |
| `test/llm.test.mjs` | OpenAI-compatible chat + SSE streaming |
| `test/run-e2e.mjs` | Closed-loop integration (mock LLM server) |
| `test/run-mcp-test.mjs` | MCP smoke (mock stdio server) |

## CI Pipeline

```
lint (eslint)
  → typecheck (tsc --noEmit)
    → build (tsc)
      → unit tests (node --test test/*.test.mjs)
        → e2e closed-loop (mock LLM server)
          → MCP smoke (mock stdio server)
```

## Node Version Matrix

CI tests on: **Node.js 20, 22, 24**