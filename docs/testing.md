# Testing

## Run Tests

```bash
npm test          # build + full unit suite + e2e + MCP smoke (prints its totals)
npm run lint      # ESLint flat config
npm run typecheck # tsc --noEmit
npm run build     # tsc
npm run coverage  # build + coverage report
npm run check:layers       # architecture dependency guard
npm run check:layers:graph # regenerate docs/architecture-graph.md
npm run eval               # scripted end-to-end scenarios (mock LLM)
npm run coverage:check     # coverage gate — floors enforced in CI
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
| `test/webfetch.test.mjs` | HTML→text, JSON, redirects, SSRF guard, IP pinning (rebinding), binary refusal |
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

Three lanes (`.github/workflows/ci.yml`):

```
ubuntu matrix (Node 20/22/24)     macOS (Node 22)             ubuntu (Node 22)
  lint → typecheck → layer check    build → npm test → eval      npm run coverage:check
  → docs:check → secrets              (Seatbelt enforcement       (floors: 88 lines /
  → build → test → eval                tests actually run)         78 branch / 84 funcs)
```

- `npm run lint` carries `--max-warnings=43` — a ratcheted budget: the
  remaining warnings (complexity, consistent-type-imports…) are tracked, but
  NEW ones fail the build. Lower the number in package.json as warnings are
  burned down; never raise it without review.
- `docs:check` fails the build when README/docs drift from argv tables or
  reference `src`/`dist` paths that no longer exist.
- `scripts/check-secrets.mjs` scans the committed `.scoderrc.json` for API
  keys (also wired as a pre-commit hook recipe in README).
- `coverage:check` runs the suite with node's built-in coverage and fails
  below the floors in `scripts/check-coverage.mjs` (override locally with
  `SCODER_COVERAGE_MIN="lines,branch,funcs"`).
- macOS lane exists because darwin-only gates (sandbox-exec/Seatbelt)
  silently skip on Linux.
- `prepublishOnly` runs lint + typecheck + FULL test + eval — publishing
  cannot bypass the gates anymore.
