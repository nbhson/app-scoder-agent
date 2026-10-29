# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [0.4.0] - 2026-10-29 — Enterprise hardening & cost tracking

### Added
- **`scoder cost` subcommand** — token usage & cost tracking from JSONL logs:
  - new `llm_usage` events (input/output/cached tokens, model, provider) per LLM call
  - session usage totals (`usage` field in session state, backward compatible)
  - model pricing table (~25 models) with `modelPricing` override in `.scoderrc.json`
  - `--session <id>` / `--last <n>` filters, human-readable cost report
- Extended catastrophic command patterns in permissions: `rm` flag variants, `mkfs.*`, `dd of=/dev/*`, `chmod -R 777 /`, block-device redirects, `sh -c`/`base64` wrappers of `rm -rf`
- 42 new tests (cost tracking, permissions) — suite now 158 passing

### Changed
- `agent.ts` refactor: `rejectToolCall()`/`pushToolResult()` helpers, removed duplicated tool-result blocks
- Malformed `.scoderrc.json` / `package.json` now warn instead of silent catch
- `safePath` distinguishes ENOENT from other fs errors (wraps in `cause`)

## [0.3.0] - 2026-10-28 — Rename to scoder & release readiness

### Changed
- **BREAKING: the CLI is renamed from `coder` to `scoder`** to match the repository/package name (`app-scoder-agent`):
  - command: `coder` → `scoder` (re-install globally after upgrading)
  - environment variables: `CODER_*` → `SCODER_*` (e.g. `SCODER_API_KEY`, `SCODER_BASE_URL`, `SCODER_MODEL`)
  - config file: `.coderrc.json` / `.coderrc` → `.scoderrc.json` / `.scoderrc`
  - data directories: `.coder/sessions/` → `.scoder/sessions/`, `.coder/logs/` → `.scoder/logs/` (rename the folder manually to keep old sessions)
  - system prompt identity: "You are Coder" → "You are Scoder"
- **Install from GitHub** — `npm install -g github:nbhson/app-scoder-agent` now works via a `prepare` build step; README gained a full Installation section (GitHub install, `npx`, npm-registry path).

### Fixed
- **`[q]uit` in edit confirmation now stops the run** — `permissions.abortRequested` was set but never read; the agent loop now observes it and stops the run.
- **Completion detection tightened** — the loose regex `/done|finished/i` triggered spurious build checks on almost any assistant text ("I'm not done yet", "package.json"...). Replaced by strict `claimsCompletion()` requiring explicit completion phrases.
- **`SCODER_MAX_STEPS` validation** — a non-numeric/zero/negative value produced `NaN` and silently ran zero steps; now validated with fallback to 40.

### Changed
- **`run_command` is now async (`spawn` instead of `execFileSync`)** — the event loop no longer blocks during long builds: streaming output renders, SIGINT is handled promptly, and the running shell command is terminated immediately on Ctrl+C (SIGTERM → SIGKILL after 5 s).
- **MCP tools are disabled in `readonly` mode** — MCP tools bypass the built-in permission policy (no command classification, no diff preview), so they cannot run in readonly mode; a warning is shown at startup if MCP servers are configured.

### Tests
- 116 unit tests (+12): `claimsCompletion` strictness, async `run_command` (timeout kill, abort signal, parallel execution, output clamp), `SCODER_MAX_STEPS` validation.

## [0.2.0] - 2026-10-28 — Enterprise hardening

### Added
- **Native Anthropic SSE streaming** — real-time token streaming (message_start / content_block_delta / message_delta / message_stop) with tool_use `input_json_delta` accumulation; no more non-streaming fallback for Anthropic models.
- **REPL shared session** — `scoder` interactive mode now keeps one `Agent` for the whole conversation (`runTurn` appends to existing history); SIGINT aborts the current turn gracefully.
- **`scoder logs <id|last> [filter]`** — view a session's structured JSONL log from the terminal.
- **Shared session on disk** — sessions store the working directory; `pruneSessions` only deletes *completed* sessions older than the cutoff (unfinished ones are kept for resuming); malformed session files are pruned immediately.
- **ESLint pipeline** — flat config with typescript-eslint + strict rules (`eqeqeq`, `prefer-const`, `no-useless-assignment`, `no-useless-escape`); CI runs lint before typecheck/build/test.
- **Secrets pre-commit scanner** — `scripts/check-secrets.mjs` blocks commits containing `sk-*`/`ghp_*`/`xox*`/`AIza*` keys or an `apiKey` field in `.scoderrc.json`.
- **Coverage** — `npm run coverage`: 90.28% lines / 81.59% branch / 90.13% functions across 104 unit tests (9 suites), plus e2e closed-loop and MCP smoke tests.
- `.scoderrc.example.json` reference config; `files` allowlist + npm provenance in `package.json`.

### Fixed
- **Permission-prompt hang (critical)** — timeout never fired because the readline promise was never raced; now `Promise.race` with the abort signal, timeout denies by default.
- **Premature build exit (critical)** — a mid-task `npm install` matched the build-command check by first word and ended the run; now matches the full command.
- **Stream error timer leak (critical)** — a failed streaming request left the 120 s request timer running, hanging the process for 2 minutes after every stream error (`cleanup()` now runs on the error path).
- **Symlink escape** — `write_file`/`edit_file` resolve the real path and refuse to touch files outside the working directory.
- **Session save wrote to the wrong directory** — `mkdir` used a hand-rolled dirname helper instead of the sessions dir.
- **`SCODER_LOG_FILE=1`** — created a file literally named `1` instead of the auto path.
- **`Number("") === 0` Retry-After** — missing `Retry-After` header zeroed the backoff and hammered rate-limited APIs.
- **SIGINT** now cancels the in-flight LLM request and saves the session; `confirmEdit` has a 120 s timeout; `stop_reason` precedence fixed; build result reused instead of double-executed; stream bodies are cancelled; error bodies redact `sk-*` keys; `read_file` caps at 2 MB; diff rendering caps lines; 13 lint errors fixed.

### Tests
- 104 unit tests across 9 suites (permissions, permission-prompt, tools, core, config, session, anthropic, llm + e2e/MCP runners), auto-discovered via `test/*.test.mjs`.
- Coverage: 90.28% lines / 81.59% branch / 90.13% functions (`npm run coverage`).

## [0.1.0] — Initial release

- Autonomous loop: plan → tool calls → build verification until the build passes.
- Tools: write_file, edit_file, read_file, list_dir, grep, run_command.
- OpenAI-compatible providers + Anthropic (auto-detected), MCP stdio servers.
- Permission policy (readonly / auto / ask / full + allow/deny lists), session save/resume, unified-diff previews.
