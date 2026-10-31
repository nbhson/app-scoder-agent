# scoder — Autonomous Coding Agent CLI

[![CI](https://github.com/nbhson/app-scoder-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/nbhson/app-scoder-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![node](https://img.shields.io/node/v/app-scoder-agent)](https://www.npmjs.com/package/app-scoder-agent)

**scoder** is a command-line coding agent that autonomously writes, edits, and builds code until your project compiles without errors. It mirrors the workflow of opencode, cline, and Claude Code, but runs as a single standalone CLI tool.

## Installation

**Requirements:** Node.js ≥ 20.19 (eslint 10 in devDependencies requires it; runtime itself works on 18+)

### Install from GitHub (current method)

The package is not yet on the npm registry — install straight from this repo:

```bash
# Clones, builds (via the prepare script), and installs the `scoder` command globally
npm install -g github:nbhson/app-scoder-agent
```

Or manually from a local clone:

```bash
git clone https://github.com/nbhson/app-scoder-agent.git
cd app-scoder-agent
npm install
npm run build
npm install -g .        # or: npm link
```

> Upgrading: pull the latest code and re-run `npm install -g .` (or point the global install at the repo again).

### Try without installing

```bash
npx github:nbhson/app-scoder-agent "your task here"
```

### From npm (planned)

Once published to the npm registry, installation will be a one-liner:

```bash
npm install -g app-scoder-agent
# or run ad-hoc:
npx app-scoder-agent "your task"
```

## Quick Start

```bash
# One-time setup wizard — writes .scoderrc.json (base URL, key, model, build cmd)
scoder init

# …or set your API key manually
export SCODER_API_KEY=sk-...          # any OpenAI-compatible key (OpenAI, Groq, OpenRouter, Ollama, …)
export OPENAI_BASE_URL=https://api.openai.com/v1  # optional, for custom endpoints

# Run a task
scoder "add a ping function to src/network.ts"

# Interactive REPL (supports /help, /clear, /cost, /model, /skills, /skill, /mcp, /review, /permission)
scoder
```

## How It Works

```
You (task) → LLM plans → Tools execute code → Build runs → Success? → Done
                              ↑                  |
                              └── Build failed? ─┘ (auto-loop)
```

**Key constraint:** scoder runs autonomously without stopping for confirmation prompts. If the build fails, it reads the error, patches the code, and retries automatically — until the build passes or the max-step limit is reached.

## Tool Set

| Tool | Description |
|------|-------------|
| `read_file` | Read a file with line numbers |
| `write_file` | Overwrite/create a file |
| `edit_file` | Find-and-replace (unique match required) |
| `list_files` | Recursive directory listing |
| `run_command` | Execute any shell command (subject to permission policy) |
| `web_fetch` | Fetch a public HTTP(S) URL → readable text (HTML→text, JSON pretty-printed) |
| `write_todos` | Live plan for multi-step tasks (checkbox list, kept current) |
| `load_skill` | Load a SKILL.md into context when the task matches its description |
| `mcp__<server>__<tool>` | Tools from configured MCP servers (routed transparently) |

File writes (`write_file` / `edit_file`) are symlink-safe: paths are resolved via `realpath` and cannot escape the working directory, even through a malicious symlink. `read_file` refuses files larger than 2MB with guidance to use `grep`/`head`/`tail`.

### Web access (`web_fetch`)

The agent can read the internet through the built-in `web_fetch` tool — it fetches exact URLs (it cannot search) and returns readable plain text: HTML is converted to text (scripts/styles stripped, entities decoded, title extracted), JSON is pretty-printed, binary content is refused. The system prompt instructs the agent *when to fetch* (external/API docs, URLs in error messages, current versions, changelogs) and when not to (answer available locally).

Safety defaults:

- **SSRF protection** — `localhost`, private and link-local addresses (10.x, 172.16/12, 192.168.x, 127.x, 169.254.x, IPv6 ULA/link-local) are blocked. Set `SCODER_WEB_ALLOW_PRIVATE=1` to allow local dev servers.
- Only `http`/`https`; up to 5 redirects — every hop is re-validated against the private-address block list.
- 30 s timeout, SIGINT-abortable; body capped at 512 KB; extracted text capped at 20k chars (configurable via `max_chars`).
- HTML is converted to plain text (no JS execution); images/archives/PDFs are refused.
- Read-only — the tool never writes locally, so it is allowed even in `readonly` permission mode.

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCODER_API_KEY` | — | API key (required) |
| `SCODER_MODEL` | `gpt-4o-mini` | Model name |
| `SCODER_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `SCODER_BUILD_CMD` | auto-detected | Build/compile command |
| `SCODER_MAX_STEPS` | `40` | Max loop iterations before giving up |
| `SCODER_PERMISSION` | `auto` | Permission mode: `auto` \| `ask` \| `readonly` |
| `SCODER_STREAM` | `1` | `0` to disable streaming LLM output |
| `SCODER_STREAM` | `1` | `0` to disable streaming LLM output |
| `SCODER_SERVER_TOKEN` | — | `scoder serve` only: require `Authorization: Bearer <token>` |
| `SCODER_WEB_ALLOW_PRIVATE` | — | Set to `1` to let `web_fetch` reach localhost/private addresses (local dev) |
| `SCODER_NO_APIKEY_WARNING` | — | Set to `1` to suppress the apiKey-in-rc warning |

### Per-project config file (.scoderrc.json)

For any OpenAI-compatible endpoint, just point `baseUrl`, `apiKey`, and `model` at it — no code changes needed. Create `.scoderrc.json` in your project root (see `.scoderrc.example.json`):

```json
{
  "baseUrl": "https://api.groq.com/openai/v1",
  "apiKey": "gsk_...",
  "model": "llama-3.3-70b-versatile"
}
```

Then simply run `scoder "your task"` — values are picked up automatically.

### Global config (~/.scoder/config.json)

Machine-wide defaults shared by **all** projects: `mcpServers`, `model`, `baseUrl`, `permission`, `permissions` lists, `modelPricing`… The project `.scoderrc.json` wins field-by-field; `mcpServers` and lists merge per-key (project entries override same-named global ones). API keys are safe here — the file lives in your home dir, outside any repo.

#### All fields

| Field | Default | Description |
|---|---|---|
| `baseUrl` | `https://api.openai.com/v1` | OpenAI-compatible endpoint (must support `/chat/completions` with tool calling) |
| `apiKey` | — | API key (⚠️ prefer `SCODER_API_KEY` env var, see warning below) |
| `model` | `gpt-4o-mini` | Model name served by the endpoint |
| `buildCmd` | auto-detected | Build/compile command (stop condition) |
| `maxSteps` | `40` | Max autonomous loop iterations |
| `stream` | `true` | Stream LLM output token-by-token |
| `provider` | auto-detected | `openai` \| `anthropic` |
| `permission` | `auto` | `auto` \| `ask` \| `readonly` |
| `mcpServers` | — | MCP stdio servers (see below) |
| `permissions` | — | `{ mode, allowCommands, denyCommands }` |

#### Precedence

Values are merged from highest to lowest priority — your `.scoderrc.json` value only applies when no flag/env is set:

1. **CLI flags** — `-m`, `--base-url`, `-k`, `--provider`, `-B`
2. **Environment variables** — `SCODER_API_KEY` / `OPENAI_API_KEY`, `SCODER_BASE_URL`, `SCODER_MODEL`, …
3. **`.scoderrc.json`** (or `.scoderrc`) in the project root, merged over the global `~/.scoder/config.json` — project values win field-by-field; `mcpServers`/lists/pricing merge per-key
4. Built-in defaults

> 💡 If your config in `.scoderrc.json` seems ignored, check `echo $SCODER_API_KEY` — env vars override the file.

#### Examples for common providers

```jsonc
// Local Ollama
{
  "baseUrl": "http://localhost:11434/v1",
  "apiKey": "ollama",
  "model": "qwen2.5-scoder:32b"
}
```

```jsonc
// DeepSeek
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-chat"
}
```

#### Notes

- Models starting with `claude-`, or a `baseUrl` containing `api.anthropic.com`, automatically switch to the native Anthropic provider — no `provider` field needed.
- If an `apiKey` is present in the rc file, scoder prints a warning on every run. Silence it with `SCODER_NO_APIKEY_WARNING=1`.

> ⚠️ **Security:** never commit `apiKey` in `.scoderrc.json` — add the file to `.gitignore` and prefer `SCODER_API_KEY` env var or the `-k` flag. A pre-commit check is available at `scripts/check-secrets.mjs`.

## Permissions & Safety

scoder ships with a layered permission system for `run_command`:

| Mode | Behavior |
|------|----------|
| `auto` (default) | Autonomous — runs shell commands without confirmation (original behavior) |
| `ask` | Prompts before each shell command not covered by `allowCommands` |
| `readonly` | Shell commands are disabled entirely; the agent can only read/list files. MCP tools are also disabled (they bypass the permission policy) |

Layered checks, in order:

1. **Catastrophic deny list** — `rm -rf /`, `dd of=/dev/...`, fork bombs, `curl | sh`, etc. are **always denied**, in every mode.
2. **`denyCommands`** (config) — always denied.
3. **Session allowlist** — commands you approved with `[a] always allow` in this session.
4. **`allowCommands`** (config) — auto-approved.
5. **Mode** — `auto` runs everything else; `ask` prompts; `readonly` denies.

In `ask` mode the prompt offers `[y] yes / [a] always allow "<prefix>" / [n] no / [q] quit`. With `-y` (non-interactive), commands needing confirmation are denied instead of hanging CI.

## Skills (SKILL.md)

scoder can load reusable instruction packs ("skills") into the conversation. A skill is a directory with a `SKILL.md` (YAML-lite frontmatter + markdown body):

```
.scoder/skills/code-review/SKILL.md     # project-level
~/.scoder/skills/code-review/SKILL.md   # global (project overrides on name clash)
```

```markdown
---
name: code-review
description: Review code for bugs, security issues, and style
---
Read the current diff. Check for: null derefs, injection risks, ...
```

- **Advertised to the model** — every run's system prompt lists skill names + descriptions; the agent reads a matching `SKILL.md` itself via `read_file` when a task fits
- **Explicit load** — `/skill <name>` stages the skill's content; it is injected as context before your next task
- **`/skills`** lists everything discovered (both scopes)

## Slash commands (REPL + TUI)

| Command | Description |
|---|---|
| `/help` | command list |
| `/clear` | reset conversation + agent context |
| `/cost` | session token usage |
| `/model` | active model/provider/build |
| `/skills` | list discovered skills |
| `/skill <name>` | stage a skill for the next task |
| `/mcp` | MCP servers + tools; exec one directly: `/mcp <server> <tool> [json\|text]` or `/mcp mcp__server__tool [json\|text]` — non-JSON text binds to the tool's first string parameter |
| `/review <prompt>` | Prompt gate (prompt-gate MCP): LLM rewrites your prompt, you pick original/rewritten/update/cancel — only the approved prompt is used |
| `/permission <auto\|readonly>` | switch permission mode at runtime |
| `/exit` | quit |

In the TUI, **Tab** completes commands (and `/skill` names), **↑/↓** recall sent-message history.

## Planning tool

For multi-step tasks the agent writes a live plan with `write_todos` (`[x]` completed · `[~]` in progress · `[ ]` pending) — rendered inline in the TUI and included in session state.

## Guardrails (Guardrail Engine)

The autonomous loop is wrapped by a configurable rule engine (`src/guardrails.ts`) — every rule is a pure function over the step context that returns a decision (`inject` a reminder / `finish` / `verify-build` / `trim`), and every triggered decision is logged to the JSONL log (`type: "guardrail"`) and surfaced as an `AgentEvent` for frontends:

| Rule | What it does |
|---|---|
| `wrap-up` | Injects a converge-now reminder 2 steps before the budget ends |
| `chat-done` | Ends conversational turns (marker-based) without a build |
| `completion-claim` | Never trusts "the task is complete" — forces an independent build verification |
| `text-only-streak` | Ends the run after 2 consecutive tool-less steps with no file changes (the "chào" failure mode) |
| `continue-nudge` | Nudges plain-text answers back to work |
| `doom-loop` | Intervenes after 3× identical consecutive tool-call batches |
| `build-stop` | Ends the run when the exact build command succeeds; re-verifies on failure |
| `history-trim` | Char-budget history trimming with whole-turn drops + old-tool-result pruning |

Thresholds are configurable via `GuardrailOptions` (`textOnlyStreakLimit`, `doomLoopRepeats`, `wrapUpStepsBeforeEnd`) without touching the loop, and custom rules can be added via `GuardrailEngine.register()`.

## Usage & cost metrics

`scoder cost` reads the JSONL logs and reports per session and total: LLM calls, tokens (in/out/cached), estimated cost, **steps, average LLM latency, tool calls, guardrail interventions, and the session success rate**:

```
  20261031-110353-d034  calls=1  in=4,042  out=88  cost≈$0.0022  |  steps=1 llm-avg=7.5s tools=1 guardrails=1 ✓success
TOTAL (1 session(s))  ...  |  success-rate=1/1
```

The system prompt is versioned (`PROMPT_VERSION` in `src/prompt.ts`) and stamped into every session log (`type: "prompt_version"`) so prompt quality can be compared across versions.

## MCP Servers (stdio)

scoder can use tools from [MCP](https://modelcontextprotocol.io) servers configured in `.scoderrc.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
    }
  }
}
```

- Tools are exposed to the LLM as `mcp__<server>__<tool>` (no name collisions with built-ins)
- Servers connect at agent start; a failing server only logs a warning — the agent keeps running with its built-in tools
- `{env:VAR}` substitution keeps secrets out of config files
- Built-in tools always take priority over MCP tools with colliding names
- ⚠️ **MCP tools bypass the built-in permission system** (no command classification, no diff preview). In `readonly` mode they are therefore disabled entirely; in `auto`/`ask` mode they run unsandboxed — only add MCP servers you trust.

### Prompt gate (`/review`)

If the [`prompt-gate`](https://github.com/nbhson/s-universal-prompt-gate-mcp) MCP server is configured (`~/.scoder/config.json`), `/review <prompt>` runs the gated rewrite flow — like OpenCode's `review-and-select-prompt`:

```
/review phân tích project
  → [1] light  [2] balanced  [3] detailed     ← you pick the rewrite level
  → ORIGINAL vs REWRITTEN shown side by side
  → [1] original  [2] rewritten  [3] update <changes>  [4] cancel
  → ✔ prompt approved: <the exact text you approved>
```

- **You approve exactly what you read** — the approved text is echoed verbatim from the server's pending result, never re-typed by the model or you
- `[3] update` loops: describe changes, the prompt is rewritten again, review repeats until you pick original/rewritten/cancel
- Cancel approves nothing; LLM errors fail loudly (no silent fallback to the original)

## Sessions

Every run auto-saves its state (messages, steps, build result) to `.scoder/sessions/<id>.json` after each step. If the run is interrupted (Ctrl+C, crash, max steps), you can continue where it left off:

```bash
scoder list                      # list saved sessions
scoder resume last               # continue the most recent session
scoder resume <id> "follow-up"   # resume + add a new instruction
```

Sessions older than 7 days are pruned automatically on the next run. Use `--no-save` to disable (e.g. in CI).

## Streaming

scoder streams everything it can, live, as it happens:

- **LLM tokens** — assistant text renders character-by-character (OpenAI-compatible SSE and native Anthropic streaming). If a provider doesn't support streaming, scoder automatically falls back to non-streaming requests. Disable with `SCODER_STREAM=0`.
- **Tool output** — `run_command` and build output print live (dimmed block) while the command runs, instead of appearing only after it finishes. Live output is capped at 20k chars; the full output still goes to the LLM.
- **SIGINT-safe** — Ctrl+C kills the running command immediately; streamed rendering never blocks the event loop.
- Output honors `NO_COLOR` and degrades to plain text when piped (CI-friendly).

## Full-Screen TUI (`scoder tui`)

**Mission Control for the build loop** — a terminal UI built with [Ink](https://github.com/vadimdemedes/ink) (React for terminals), driven by the same `AgentEvent` stream the HTTP API exposes:

```bash
scoder tui                     # start an interactive full-screen session
scoder tui "fix the bug"       # auto-submit an initial task
```

Features:

- **Alternate screen buffer** (vim/htop style) — the app owns the full screen: the header stays pinned at the top, input + status bar at the bottom, the chat pane scrolls internally, and your terminal content is restored on exit. Terminals without alt-screen support (`TERM=dumb`, non-TTY) automatically render inline instead.
- **Build Rail** (pinned top bar) — brand, build lamp (`● build ok` / `● build fail` / `no build yet`), permission mode, and a step fuel gauge (`▰▰▰▱▱▱▱▱▱▱`) that fills as the agent burns through its step budget
- **Phase breadcrumb + live metrics** (second header row, while running) — `plan › explore › edit › build › verify` (current phase highlighted) on the left; tokens in/out, elapsed time, guardrail interventions, and the last guardrail rule on the right
- **Chat pane** — your messages, streaming assistant text with a live block cursor (`▋`), and every tool call with live stdout/stderr preview (`✔/✘` status, spinner while running, wall-clock duration per tool), prefixed with a flight-recorder step number (`03▸`)
- **Diff cards** (`✎`) — every file write/edit renders as a unified diff (`+` green / `-` red / `@@` cyan hunk headers); the same diff also flows out of the HTTP SSE stream
- **Status bar** — model, token usage (input/output/cached), scroll position, keybind hints
- **Slash commands** — `/help`, `/clear`, `/cost`, `/model`, `/skills`, `/skill`, `/mcp`, `/review`, `/permission`, `/exit` (identical to the REPL)
- **Multi-turn** — keep typing follow-ups after a task finishes; the conversation context carries over (same as the REPL)
- **Scrollback** — `PgUp`/`PgDn` page in 0.8-viewport steps, `Home`/`End` jump to top/bottom, `Esc` returns to the live tail (press again to abort); rendering is capped at the last 200 items for smooth scrolling on long runs
- **Keybinds** — `Enter` send · `PgUp`/`PgDn` scroll · `Esc` reset scroll / abort · `Ctrl+C` quit
- Non-TTY environments (CI, pipes) automatically fall back to the classic REPL
- `permission: "ask"` is not supported in the TUI (no readline prompts on the alt screen) — it falls back to `auto`

## HTTP Server Mode (`scoder serve`)

Run scoder as a local HTTP service — submit tasks programmatically and consume progress as Server-Sent Events:

```bash
scoder serve                    # http://127.0.0.1:0 (random port, printed at startup)
scoder serve --port 4114        # fixed port
SCODER_SERVER_TOKEN=secret scoder serve --host 127.0.0.1
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Liveness: `{ ok, running, runs }` |
| `/api/runs` | POST | Start a run: `{ "task": "...", "workdir?", "buildCmd?", "model?", "provider?", "maxSteps?", "permission?" }` → `202 { id, eventsUrl }` |
| `/api/runs` | GET | List runs with status/timing |
| `/api/runs/<id>` | GET | Run status + final result |
| `/api/runs/<id>/events` | GET | **SSE stream** — full event replay, then live, closes on finish |
| `/api/runs/<id>/abort` | POST | Abort a running run (equivalent to SIGINT) |

SSE event types: `run_start`, `step`, `llm_delta` (assistant text), `tool_call`, `tool_output` (live stdout/stderr chunks), `tool_result`, `llm_usage`, `build`, `finish`. The stream replays every event from the beginning, then stays live, and closes after `finish` — safe to (re)connect at any time.

Notes:

- Runs are always non-interactive; `permission: "ask"` is rejected — use `auto` or `readonly`.
- Binds `127.0.0.1` by default. Set `SCODER_SERVER_TOKEN` to require `Authorization: Bearer <token>` on every request.
- Max 4 concurrent runs (extra requests get `429`); per-run overrides: `workdir`, `buildCmd`, `model`, `provider`, `maxSteps`, `permission`.

## Logging

Enable a structured JSONL event log with `--log-file` (or `SCODER_LOG_FILE=1`, or `SCODER_LOG_FILE=/path/to/log.jsonl`):

```bash
scoder --log-file "fix the failing test"
cat .scoder/logs/<session-id>.jsonl | jq 'select(.type == "error")'
```

Events: `step` (with `durationMs` LLM latency + tool-call count), `tool` (args, ok, elapsedMs, denied reason), `build`, `guardrail` (rule/action/reason for every Guardrail Engine decision), `prompt_version`, `finish`. One JSON object per line — pipe to `jq` or any log consumer.

## Reliability

scoder is designed for unattended use. Key guarantees:

- **Request timeouts** — LLM calls have a 120s timeout; on timeout, the agent retries or fails gracefully (never hangs indefinitely).
- **SIGINT handling** — pressing Ctrl+C cancels the in-flight LLM request immediately, kills the running shell command (SIGTERM → SIGKILL), saves the session, and exits with status 130. You can resume with `scoder resume last`.
- **Graceful retries** — transient LLM API failures (HTTP 429/5xx, network errors) are retried with exponential backoff and jitter (up to 3 retries, honoring `Retry-After`). Client errors (401/403/404) fail fast.
- **Double-build prevention** — when the agent itself runs the build command, scoder reuses that result instead of running the build twice.
- **Build diff preview** — run `scoder --permission ask` to see a unified diff before every file write/edit.

> **Design note:** the build command (stop condition) always runs without a permission prompt, even in `readonly` mode — the agent must be able to verify its stop condition. Builds are invoked as-is from your config (`buildCmd`) or auto-detection, never invented by the LLM. Shell commands *chosen by the LLM* (`run_command` tool) go through the full permission policy above.

### Auto-detected build commands

scoder detects the build command automatically:

| Project type | Detected command |
|---|---|
| `package.json` with `scripts.build` | `npm run build` |
| `Makefile` | `make` |
| `go.mod` | `go build ./...` |
| `Cargo.toml` | `cargo build` |
| `tsconfig.json` | `npx tsc --noEmit` |
| `pyproject.toml` | `python -m compileall .` |

## CLI Options

```
scoder [options] "<task>"     Run a task autonomously until the build passes
scoder                       Start interactive session
scoder init                  Setup wizard — writes .scoderrc.json (+ connection test)
scoder tui [task]            Full-screen terminal UI (Mission Control)
scoder serve [--port] [--host]   HTTP server mode (see above)
scoder --help | --version     Help and version
```

| Flag | Description |
|------|-------------|
| `-m <model>` | Model to use |
| `--base-url <url>` | OpenAI-compatible API base URL |
| `-k <key>` | API key |
| `-B, --build <cmd>` | Build command (stop condition) |
| `-d, --dir <path>` | Working directory |
| `-s, --max-steps <n>` | Max iterations (default 40) |
| `--permission <mode>` | `auto` \| `ask` \| `readonly` shell-command policy (default `auto`) |
| `-y` | Non-interactive mode (denies commands needing confirmation) |
| `--provider <name>` | `openai` \| `anthropic` (env SCODER_PROVIDER; auto-detected) |
| `--no-save` | Disable session auto-save to `.scoder/sessions/` |
| `--log-file` | Write a structured JSONL event log to `.scoder/logs/` |
| `--port <n>` | (`serve`) TCP port, `0` = random free port |
| `--host <addr>` | (`serve`) Bind address (default `127.0.0.1`) |

## Examples

```bash
# Run a task (auto-saves session to .scoder/sessions/)
scoder -B "npm test" "fix the null pointer in UserService"

# Resume after a crash or interrupt
scoder resume last "now add unit tests for the fix"

# Interactive mode with permission guard
scoder --permission ask "npm install express and wire up a route"

# Custom LLM (Groq, Ollama, vLLM, OpenRouter…)
scoder --base-url https://api.groq.com/openai/v1 -k $GROQ_KEY \
  "add input validation to the CLI"

# Anthropic (auto-detected when model starts with 'claude-')
scoder -m claude-sonnet-4-5 "refactor the parser module"

# CI: non-interactive, no session saving
scoder --no-save -y "run the full migration"

# Run as an HTTP service and consume progress via SSE
scoder serve --port 4114 &
curl -s -X POST localhost:4114/api/runs -H 'Content-Type: application/json' \
  -d '{"task": "add input validation to the CLI"}'
curl -N http://127.0.0.1:4114/api/runs/<id>/events     # live progress

# Fetch external docs during a task (agent decides when, via web_fetch)
scoder "upgrade express to v5 — check the official migration guide first"
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  CLI (src/index.ts)                         │
│   arg parsing, REPL, serve, tui, SIGINT     │
└───────┬─────────────────────┬───────────────┘
        │                     │
┌───────▼───────────┐  ┌──────▼─────────────────────┐
│  TUI (src/tui/)   │  │  Agent (src/agent.ts)      │
│  Ink/React alt-   │  │  Closed-loop orchestrator  │
│  screen UI,       │─▶│  + Guardrail Engine        │
│  renders the same │  │  (src/guardrails.ts)       │
│  AgentEvent stream│  │  emits AgentEvent          │
└───────────────────┘  └──┬──────────┬──────────────┘
                          │          │
                          │          └────────────────────┐
                          ▼                               ▼
┌───────────────────────────────┐   ┌──────────────────────────┐
│  LLM Client (src/llm.ts)      │   │  Server (src/server.ts)  │
│  OpenAI-compatible + native   │   │  HTTP API + SSE          │
│  Anthropic provider           │   │  runs in background      │
└──────────────┬────────────────┘   └──────────────────────────┘
               ▼
┌────────────────────────────────────────┐
│  Tool Registry (src/tools.ts)          │
│  + web_fetch (src/webfetch.ts)         │
└──────────────┬─────────────────────────┘
               ▼
┌───────────────────────────────┐
│  Build Checker (src/build.ts) │
│  run build → exit 0 = stop    │
└───────────────────────────────┘
```

## Integration Testing

```bash
npm test          # runs: build → unit tests (node --test) → e2e closed-loop → MCP smoke
npm run lint      # eslint flat config (typescript-eslint + eqeqeq, prefer-const...)
npm run typecheck # tsc --noEmit
```

Test suites (run with `npm test` — auto-discovers `test/*.test.mjs`):
- `test/permissions.test.mjs` — catastrophic patterns, mode classification, allowlist word-boundary, timeout-denies
- `test/permission-prompt.test.mjs` — interactive prompt timeout behavior
- `test/tools.test.mjs` — safePath traversal, symlink escape, file-size cap, write/edit/list, live `run_command` output streaming
- `test/webfetch.test.mjs` — HTML→text, JSON, redirects, SSRF guard, binary refusal, truncation
- `test/server.test.mjs` — HTTP API: run lifecycle via SSE, abort, auth, live `tool_output` events
- `test/tui.test.mjs` — full-screen TUI in a real PTY (via `test/pty-run.py`): closed loop render + slash commands (`/help`, `/cost`) + clean exit
- `test/tui-state.test.mjs` — event reducer unit tests: diff items, build lamp, abort marking, slash-command parsing & help formatting
- `test/review-flow.test.mjs` — `/review` prompt-gate wiring: both pending stages, approved/cancelled outcomes, verbatim `rewritten_prompt` echo (security)
- `test/core.test.mjs` — unified diff, retry backoff, context trimming
- `test/config.test.mjs` — env/rc/cli precedence, logFile mapping, permission lists
- `test/session.test.mjs` — session store, smart prune, resolve
- `test/cost.test.mjs` — token usage & cost aggregation, session metrics (latency/success/guardrails)
- `test/guardrails.test.mjs` — Guardrail Engine: rule registry, default rules, configurable thresholds, decision logging, priority order
- `test/prompt.test.mjs` — system prompt versioning (`PROMPT_VERSION`) + dynamic assembly
- `test/anthropic.test.mjs` — message translation + native SSE streaming
- `test/llm.test.mjs` — OpenAI-compatible chat + SSE streaming + redaction + wire-format normalization
- `test/run-e2e.mjs` — closed-loop integration (mock LLM server)
- `test/run-mcp-test.mjs` — MCP smoke (mock stdio server)

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Task completed — build passed |
| `1` | Build failed after max steps |
| `2` | Fatal error (no API key, network error, etc.) |

## License

MIT
