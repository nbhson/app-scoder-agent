# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [0.9.10] — 2026-11-13

### Performance
- **TUI transcript virtualization (P1-8)** — the viewport now mounts only the
  window of items around the scroll position (`transcriptWindow` + row
  estimates cached per item identity) instead of the full transcript at full
  height. Measured with a fake-TTY bench over the real `ChatItemView`
  pipeline: commit cost 42–53 ms/frame → **9.0–9.4 ms** at 302–400 items;
  typing echo stays O(window) regardless of transcript length. Follow-bottom
  uses the measured height of the mounted window, so estimate error can never
  clip the newest line.
- **Stable KV-cache prefix across windows (P0-10)** — REPO MAP left the system
  prompt for a tail context message, and its volatile bytes (per-file sizes,
  file-count header) are gone. Three fresh processes, one greeting each,
  against llama.cpp: unchanged repo **0.21 s** (was 30.2 s), repo + one new
  file **8.9 s at 84 % cache** (was 30.2 s). Editing existing files no longer
  invalidates other windows' prompts.
- **One LLM call per chat turn (P0-8)** — a tool-less step with no open plan
  and no file changes finishes immediately instead of injecting a nudge and
  paying a second full call (measured before: 14.488 + 14.569 tokens per
  greeting). Tasks with an open plan or file edits keep the nudge/build path
  (`aec95ef` behavior guarded by tests).

## [0.9.9] — 2026-11-13

### Fixed
- **TUI sidebar froze after the second question** — every entry point into the
  run loop (`run`, `runTurn`, `resume`) now emits a `run_start` boundary
  (`Agent.emitRunBoundary()`), so tok/s, context usage and the transcript stay
  realtime across turns.
- **The real context window is read from the server** (`/props`, `/slots`,
  auth-aware probe) instead of assuming 128k; fixed prompt cost is calibrated
  from engine-reported `prompt_tokens`, per-slot `n_ctx` is honored.

### Performance
- KV-cache prefix kept stable across steps; tool output capped per slot
  (`limits.toolOutputChars`); MCP schema budgeted against the *probed* window
  (`SCHEMA_SHARE_OF_WINDOW` = 35 %); output reserve clamped; prompt metrics
  split in logs.
- New measurement tooling (see docs/performance.md):
  `scripts/capture-prompt-proxy.mjs` records the exact request body + usage/TTFT
  between any agent and llama.cpp; `scripts/measure-prompt-anatomy.mjs` replays
  captures with `max_tokens: 1` (modes `anatomy|blocks|warmcold|scatter`).
- Engine-measured comparison vs OpenCode, per-block prompt costs and ranked
  follow-ups (P0-7/P0-8/P0-9) are recorded in `plan/performance-issue.md` §13.

## [0.9.8] — 2026-11-11

### Fixed
- `read_file` no longer silently collapses to a 4k window (full file or an
  explicit truncation notice).
- Review/report tasks no longer finish early just because a build passed —
  verification guardrails only stop the run when the task itself is complete.

## [0.9.7] — 2026-11-07

### Changed
- **Default system prompt compacted into V6**: ~37% fewer tokens while preserving
  the same agent behavior and instructions.

## [0.9.5] — 2026-11-07

### Changed
- **Sidebar widened** 40 → 60 cols (`SIDEBAR_MIN_COLS` 92 → 112); chat width
  math now derives from `SIDEBAR_WIDTH` instead of a hardcoded constant.
- **Welcome screen**: big block-letter SCoder banner, vertically + horizontally
  centered in the chat viewport (small panes fall back to the one-line logo;
  ASCII variant under `SCODER_ASCII=1`/`TERM=dumb`).

### Fixed
- **`/skill <name> <task>` swallowed the task text** — the skill was staged but
  the run never started, so MCP-gated workflows (e.g. prompt-gate) never fired.
  The handler now splits the skill name (`matchSkillPrefix`, longest-name /
  word-boundary match) from the task text and submits the task immediately with
  the skill applied to that run.
- PTY integration test runs at 130 cols so the wider sidebar stays visible.

## [0.9.4] — 2026-11-07

### Fixed
- **TUI chat frozen after the markdown-pipeline refactor** (regression from 0.9.3): `ChatItemView` is `React.memo`-wrapped but `state.ts` mutated chat items in place, so prev/next props were the SAME object and the memo blocked every re-render — streaming text froze at the first chunk and tools stayed "running" forever. All item updates are now immutable (`patchItem` replaces the object in `items`); regression tests pin the immutability contract.
- **Sidebar section order restored** to the original layout: SESSION → MCP → METRICS → PHASES → PLAN → SUBAGENTS → BUILD. Sections greedy-fit the measured height budget (a section that doesn't fit wholly is skipped, never half-clipped); PLAN shrinks to the remaining space with a "… +N more" row.
- **Plan no longer disappears on heavy runs**: the sidebar PLAN reads `state.plan`, a dedicated snapshot field immune to `MAX_ITEMS` transcript eviction; reset on every new user message (same semantics as `latestPlan`).
- **`load_skill` / `/skill` "not found" despite the skill existing**: models sometimes glue task text onto the skill name (`"review-and-select-prompt cung cấp angular…"`). `findSkill` now resolves leniently — exact → first token → longest skill-name prefix (word-boundary safe, no over-matching) — and the tool description says to pass the skill name only.

## [0.9.1] — 2026-11-05

### Changed
- Documentation sync with latest features (slash commands, CLI flags/env vars, TUI keybinds/themes, MCP governance/resources/prompts/import, custom commands, architecture modules).
- Lint clean (removed 4 `any` warnings in `src/skills.ts`).
- Synced `package-lock.json` to the current version.

## [0.9.0] — 2026-11-05

Scoder 0.9→1.0 upgrade milestone. Agent C, MCP A/B, custom commands,
TUI transcript features, backward-compat guarantees. __No breaking config
changes__: 0.8.x `.scoderrc.json`, event streams and skill files keep loading.

### Agent
- Event schema v2 (`EVENT_SCHEMA_VERSION = 2`): `run_start` carries
  `schemaVersion` + `agent`; `run_finish` carries `usage`/`verification`;
  new `queue_size`/`context_used`/`compaction`/`agent_start`/`agent_end`
  events. Reducer drops unknown additive fields (old consumers unaffected).
- `resolvePrimaryConfig()` — rc/CLI routing per primary agent (plan/build/
  review) applied before client/tools are built; agent def tool filters
  (permission/model/temperature/steps/reasoning) applied at spec level.
- Agent C: diagnostics parser + verify commands, self-review + completion
  gate, `ask_user` tool contract with timeout + `<<QUESTION>>` protocol.
- `task` batch mode: `tasks[]` runs up to 8 subtasks with bounded concurrency
  (max 4 in flight) and merges results in declaration order.
- `apply_patch` tool: atomic multi-hunk edits (one write, all-or-nothing).
- CI eval gate: `npm run eval` runs the deterministic mock-LLM suite.
- `read_file` offset/limit ranges; `grep`/diagnostics precedence fixes.

### MCP
- Protocol version + capabilities + instructions (from `initialize`);
  `tools/list_changed` notification → live tool re-registration.
- Full resources/prompts support: `resources/list|templates/list|read|subscribe`
  and `prompts/list|get`, cached per server and refreshed on
  `resources/list_changed` / `prompts/list_changed`; `resources/updated`
  and `progress` notifications surface through hooks.
- Generic agent tools `mcp_list_resources`, `mcp_read_resource`
  (optional `subscribe`), `mcp_list_prompts`, `mcp_get_prompt` — advertised
  only when a connected server supports them.
- Per-server `trust` enforcement in the permission classifier
  (`auto`/`ask`/`readonly`/`deny`); `readonly` servers are never spawned.
- Config import from Claude Desktop (`~/.claude.json`), OpenCode
  (`opencode.json`), and `.mcp.json` via `scoder mcp import`.
- Audit log (`mcp_audit` JSONL entries) for MCP tool calls and resource
  reads; MCP output flagged `untrusted: true` in the event stream and
  wrapped with an `[UNTRUSTED]` marker in the LLM conversation.
- HTTP SSE incremental streaming (`consumeSseStream`, no body buffering)
  + AbortSignal cancellation.
- Per-server tool filters (`tools.include`/`exclude` + glob) approved on the
  announcement line.
- `applyConfig` hot-restart when transport-effective config changes; stdio
  `taskkill`-based kill-tree on shutdown.
- Per-server `enabled`/`trust` (auto/ask/readonly/deny); readonly trust
  disables spawn. `scoder mcp` CLI to list/inspect servers + tool namespaces.

### Custom commands
- `.scoder/commands/*.js` custom slash commands discovered at startup
  (`scoder.commands(dir, meta)` export contract), listed in `/commands`,
  weight = low for built-in priority.
- Unified command registry (`BUILTIN_COMMANDS` + `commandCatalog()`) shared
  between REPL and TUI completion.

### TUI
- `/export [md|json]` — writes the session transcript to workdir/
  `scoder-export.{md|json}`; `/search <query>` — case-insensitive keyword
  search with snippets and scroll-to-result.
- Subagent sidebar section (running/ok/failed + summary + steps).
- `toolPhase` polish: `mcp__*`→"mcp", `repo_map`→"explore",
  `ask_user`→"clear", `task`→"delegate".
- `CommandHost.transcriptItems()`/`selectTranscriptItem()` — shared host
  contract for REPL-safe commands.

### Skills
- Anthropic-style convention: `skills/<name>/SKILL.md` subdirectories;
  `name`+`description` frontmatter required (missing → skip + warning);
  duplicate-name dedup with scope override.

### Migration & tests
- `test/migration.test.mjs` — 0.8.x config/event/skill backward-compat suite.
- Test suite grew 149 → 178 tests across 14 files; eval stays 10/10.

## [0.8.21] — TBD

### Agent
- Context compaction now actually fires: mechanical trim only starts at 95% of the
  model window, above the 80% compaction trigger, so history is summarized
  instead of silently dropped before compaction runs
- `trimHistory()` accepts a configurable token budget (context-window aware via
  `historyTokenBudget()`)
- Added `/compact` manual command (REPL + TUI) to summarize older history on
  demand; works even when automatic compaction is disabled (`"compaction": false`)

### TUI
- `/compact` added to slash command list + tab completion + `/help`

### Bug fixes
- Auto-compaction was unreachable because `trimHistory` hard-capped history at
  90k tokens, below the 80% trigger for every model with a >=113k window

## [0.8.0] — TBD

### Agent
- System prompt V4: no wasted builds — `run_command` only runs the build after file
  edits; conversational input ends with `<<CHAT_DONE>>` instead of triggering tools
- Restored the `<<CHAT_DONE>>` marker rule (V3 dropped it) so chat-done guardrail
  fires and pure Q&A turns no longer burn steps running an empty build
- MCP connections now live for the whole agent/session lifetime (one "connected"
  line, no per-message server re-spawn); `dispose()` teardown wired into CLI, REPL,
  TUI, serve, and subagents

### Guardrails
- `continue-nudge` is context-aware: when no files were modified it nudges toward
  `<<CHAT_DONE>>` instead of demanding a build; build is only required once files
  have been changed

### TUI
- BuildRail single-row (no dual-header look); step count `x/40` removed from the
  header (already shown in sidebar + StatusBar)
- Guardrail notice spans the full available header width (dynamic fit — no more
  "…" truncation while space remains)
- Full-item render + overflow clipping → scroll works correctly
- Streaming green text auto-normalizes on new query (preSubmit helper)
- Landing page: centered big SCoder logo, version, hints
- Sidebar: live tok/s estimate (streaming chars) + ctx shows input/limit (pct%)
- Sidebar: PLAN moved to the bottom (easier to focus); SESSION no longer shows
  `perm auto`
- Plan resets in real time on each new user message — stale plan from the previous
  task clears instead of lingering
- User messages get a full colored border + `you ▸` label so they stand out from
  the agent's markdown output
- Session switch: restores step/model/provider metadata from session file

### Bug fixes
- TypeScript: preSubmit hoisting — moved before submit declaration
- Lint: unused LiveMetrics, contextWindowFor, resolveModelPricing in chrome.tsx

### Docs
- Skills format documented in system prompt + prompt-builder
- MCP servers documented as available (not auto-used)

## [0.7.0] - 2026-11-03 — TUI Mission Control v2, MCP HTTP, Model Catalog, Steering

### Added
- **TUI Session Picker Modal** — keyboard-navigable list of saved sessions; open via `Ctrl+S` or type `/sessions` (when agent is idle). Navigate with `↑/↓` or `j/k`, press `Enter` to resume, `Esc` to close. Quick-jump via number keys `1-9`.
- **TUI Visual Refresh** — polished "Mission Control" chrome:
  - **BuildRail**: bold border, `⚑ scoder` brand, center phase breadcrumb, right-aligned `[perm] ✓/○/✗ build + steps` badge
  - **StatusBar**: bold border, spinner + status + elapsed + model, compact key hint on right
  - **ToolItem**: step prefix + tool name (bold) + key arg + elapsed, ✓/✗ inline icons
  - **DiffCard**: rounded border, step badge, color-coded ± stats, path header
  - **PermissionModal**: bold border, warning header, scrollable diff, compact key legend
  - **PhaseBreadcrumb**: `●/◆` visited/current dots with spacing
  - **BuildNotice**: checkmark/x icons (`✓`/`✗`), spacing after command
- **TUI Sidebar** — live session sidebar with plan tracking, tok/s, phases, build status, MCP server state
- **TUI Themes** — 3 built-in themes (dark/light/mono) + terminal capability detection; `/theme` command
- **Image Preview in TUI** — `read_file` renders image files as halfblock preview directly in the terminal
- **Tool Progress** — callId correlation + live elapsed time per tool card
- **Vim Keybindings** — normal/insert mode + mouse wheel scroll in TUI
- **Virtual Scrolling** — render window estimated by rows for smooth scrolling on long runs
- **Permission Modal** — full diff preview + scroll + checker-level timeout in TUI
- **Model Catalog** — `scoder models` command lists context windows & pricing from models.dev; 24h cache + `--refresh`
- **Steering Inbox** — user input delivered at safe step boundaries (pattern from opencode)
- **LLM Compaction** — history summarization when approaching context window limit
- **MCP HTTP Transport** — Streamable HTTP (SSE responses) alongside stdio; `{env:VAR}` in headers
- **MCP Schema Validation** — inputSchema validated locally before calling tools
- **MCP Reconnect** — state machine + exponential backoff (max 5 attempts) + tool list refresh
- **Hot Reload** — watch `.scoderrc` + `.scoder/skills/` with 500ms debounce
- **Config Limits** — runtime thresholds via `limits.{requestTimeoutMs, maxOutputChars, toolConcurrency, renderCap}`
- **Tool Concurrency** — parallel read-only tool calls (bounded concurrency, default 4)

### Changed
- **`prepublishOnly`** — simplified to `npm run lint && npm run typecheck` (faster publish, no full test suite)
- **`engines`** — bumped to `>=20` (was `>=18`)
- **TUI Render Cap** — capped at 200 items for smooth scrolling
- **Idle Timeout** — LLM requests use per-chunk idle timeout (reset on each data received) instead of fixed request timeout

### Fixed
- **Stream interruption** — incomplete streams with complete tool calls now continue (not fail)
- **LLM stream mid-generation** — idle timeout resets on each chunk, stream only dies on true silence
- **@file mentions** — directory listings, path escape, no email false positives

## [0.6.0] - 2026-10-30 — Mission Control TUI, unified diffs in the event stream, slash commands & `scoder init`

### Added
- **Diff cards in the event stream** — `toolWriteFile` / `toolEditFile` now compute a unified diff (`ToolDiff`: path, text, added/removed line counts, `truncated` flag) and attach it to the `tool_result` event, so **every frontend gets diffs for free**: the TUI renders `✎` diff cards (`+` green / `-` red / `@@` cyan) and SSE consumers receive the same payload.
- **"Mission Control" TUI identity** (`src/tui/app.tsx`) — a rebrand with its own character, not an OpenCode clone:
  - **Build Rail** top bar: brand, build lamp (`● build ok / fail / no build yet`), permission mode, and a **step fuel gauge** (`▰▰▰▱▱▱▱▱▱▱`, one cell per 10% of the step budget)
  - **Flight-recorder step gutter** — tool items prefixed with their step number (`03▸`), so you can read the run's history at a glance
  - **Diff cards** (`✎`) for every file write/edit (see above)
  - **Scrollback** — `PgUp`/`PgDn` scroll the chat history (10 lines/page), `Esc` returns to the live tail before aborting
  - border style `single`, magenta brand accent, lamp/gauge state in the reducer (`buildLamp`)
- **Slash commands, shared by both frontends** (`src/tui/commands.ts`): `/help`, `/clear`, `/cost`, `/model`, `/exit` (`/quit`) — same parser + help formatter used by the classic REPL *and* the TUI, so the surfaces can't drift.
- **`scoder init` setup wizard** — interactive prompts (base URL, API key, model, build command, permission mode) that write `.scoderrc.json`, with an optional live connection test ("Reply with exactly: OK") against the configured provider.
- **`Agent.getUsage()`** — public getter for session token usage (used by REPL `/cost`).
- `test/tui-state.test.mjs` — 10 unit tests for the reducer, diff items, build lamp, slash-command parser & help formatter.

### Fixed
- **TUI stale-state races** (found via a closed-loop PTY investigation):
  - `onEvent` now uses **functional `setState`** — events landing within one render batch can no longer hit a stale `stateRef` snapshot, which left tool items stuck at `running…` forever.
  - The input field keeps a **`MutableRefObject` as source of truth** (state is only a render mirror) — keystrokes arriving right after a submit can no longer merge with the old text (`/help` + `/cost` becoming `/help/cost`).
  - Slash-command submissions now clear the input field (previously only task submissions did).
- PTY test harness: the second `--send-after` rule was swallowed by argparse (missing flag repetition), producing spurious `ENOENT` failures.

## [0.5.0] - 2026-10-30 — Streaming UI, full-screen TUI, HTTP server mode & web access

### Added
- **`web_fetch` tool — internet access** — the agent can fetch public HTTP(S) URLs and read the content as plain text:
  - HTML → readable text (scripts/styles/comments stripped, entities decoded, `<title>` extracted), JSON pretty-printed, binary content types refused
  - "Knows when to fetch": tool description + a new system-prompt rule tell the LLM when web access is warranted (external/API docs, URLs in error messages, current versions) vs. not (answer available locally); the tool cannot search, only fetch exact URLs
  - SSRF guard: private/loopback/link-local addresses blocked on every redirect hop (`SCODER_WEB_ALLOW_PRIVATE=1` allows local dev servers); http/https only; ≤5 redirects; 30 s timeout; SIGINT-abortable; 512 KB body cap; 20k-char output cap (`max_chars` configurable)
  - Read-only → allowed in `readonly` permission mode
- **Live tool output streaming** — `run_command` and build output render in real time (dimmed block) while the command runs; streamed into the UI *and* exposed as `tool_output` events for server consumers. Chunks forwarded per-stream (stdout/stderr), capped at 20k chars live; full output still returned to the LLM.
- **`scoder serve` — HTTP API + SSE** (`src/server.ts`):
  - `POST /api/runs` starts a background agent run (per-run overrides: `workdir`, `buildCmd`, `model`, `provider`, `maxSteps`, `permission`)
  - `GET /api/runs/<id>/events` — SSE stream: full replay, then live events (`run_start`, `step`, `llm_delta`, `tool_call`, `tool_output`, `tool_result`, `llm_usage`, `build`, `finish`), closes on finish — safe to reconnect at any time
  - `GET /api/runs` / `GET /api/runs/<id>` / `POST /api/runs/<id>/abort` (kills the run like SIGINT); `GET /api/health`
  - Runs are always non-interactive (`ask` rejected); max 4 concurrent runs (429 beyond); optional `Authorization: Bearer` auth via `SCODER_SERVER_TOKEN`; binds `127.0.0.1` by default
- **Structured agent events** — `Agent` now emits typed `AgentEvent`s (`agent.onEvent`), decoupling progress reporting from the terminal UI
- **Fresh CLI look** — box-drawing startup banner (task/model/workdir/build/steps), `▸` step markers, dimmed live-output blocks; honors `NO_COLOR` and strips ANSI when piped (CI-friendly)
- **Full-Screen TUI (`scoder tui`)** — OpenCode-style terminal interface built with Ink + React (`src/tui/`):
  - chat pane (user messages, streaming assistant text, live tool feed with `✔/✘` status + output preview), status bar (step counter, model, token usage, keybinds)
  - multi-turn: type follow-ups after a task finishes — context carries over, same as the REPL
  - typed-while-running is preserved; `exit`/`quit` always quits (aborts a running agent first); `Esc` aborts; non-TTY falls back to the classic REPL; `permission: "ask"` falls back to `auto`
  - pure `AgentEvent` reducer (`src/tui/state.ts`) — the TUI renders nothing but the event stream, same contract as the HTTP SSE API
  - new runtime deps: `ink`, `react`

### Fixed
- **OpenAI wire format for assistant `tool_calls`** — internal history (`{id, name, arguments}`) was sent verbatim; strict providers (Upstage solar-pro4) reject it with `Invalid function name: ''`. Both `chat()` and `streamChat()` now normalize to the wire shape `{id, type: "function", function: {name, arguments}}`.

### Tests
- 27 new tests: `test/webfetch.test.mjs` (16), `test/server.test.mjs` (8 — run lifecycle via SSE, abort, auth), tool-output streaming (3). Suite now **185 passing**.
- TUI integration test in a real PTY (`test/tui.test.mjs`, runner `test/pty-run.py`) + wire-format regression tests. Suite now **188 passing**.

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
