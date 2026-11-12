# Testing

## Run Tests

```bash
npm test          # build + full unit suite + e2e + MCP smoke (959 tests)
npm run lint      # ESLint flat config
npm run typecheck # tsc --noEmit
npm run build     # tsc
npm run coverage  # build + coverage report
npm run check:layers       # architecture dependency guard
npm run check:layers:graph # regenerate docs/architecture-graph.md
npm run eval               # 11 scripted end-to-end scenarios (mock LLM)
node scripts/bench.mjs     # performance benchmark (see docs/performance.md)
node scripts/bench-context.mjs       # wasted prefill: legacy vs current trim strategy
node scripts/measure-mcp-schema.mjs  # tool-schema token cost
node scripts/capture-prompt-proxy.mjs        # record exact request bodies + usage/ttft
node scripts/measure-prompt-anatomy.mjs      # replay captures: anatomy|blocks|warmcold|scatter
```

`npm test` does not run lint/typecheck — run them explicitly (or rely on CI).

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
| `test/core.test.mjs` | Diff, retry, context trimming (`trimHistory` identity/hysteresis/orphan-safe cuts), @file mentions |
| `test/config.test.mjs` | Env/rc/cli precedence, logFile mapping |
| `test/limits.test.mjs` | rc `limits` parse/validate + new keys (`toolOutputChars`, `mcpSchemaTokens`, `mcpTools`, `verifyCache`, `contextWindow`) + local model profile — hermetic via `SCODER_CONFIG` |
| `test/perf-p0-p1.test.mjs` | Performance fixes: schema-aware token estimate, MCP tool filter + schema cap (incl. the window-aware share cap), `read_file` line-aware truncation, workspace fingerprint + verification cache, usage/prompt metrics, `probeContextWindow` against a real `node:http` mock (`/props`, `/api/show`, API key), `historyTokenBudget` clamping, fixed-cost calibration |
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
    → layer check
      → build (tsc)
      → unit tests (node --test test/*.test.mjs)
        → e2e closed-loop (mock LLM server)
          → MCP smoke (mock stdio server)
```

## Node Version Matrix

CI tests on: **Node.js 20, 22, 24**
