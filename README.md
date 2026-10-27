# coder — Autonomous Coding Agent CLI

[![CI](https://github.com/nguyenson/coder-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/nguyenson/coder-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![node](https://img.shields.io/node/v/coder-agent)](https://www.npmjs.com/package/coder-agent)

**coder** is a command-line coding agent that autonomously writes, edits, and builds code until your project compiles without errors. It mirrors the workflow of opencode, cline, and Claude Code, but runs as a single standalone CLI tool.

## Quick Start

```bash
# Install globally (or use npx)
npm install -g .

# Set your API key
export CODER_API_KEY=sk-...          # any OpenAI-compatible key (OpenAI, Groq, OpenRouter, Ollama, …)
export OPENAI_BASE_URL=https://api.openai.com/v1  # optional, for custom endpoints

# Run a task
coder "add a ping function to src/network.ts"

# Interactive REPL
coder
```

## How It Works

```
You (task) → LLM plans → Tools execute code → Build runs → Success? → Done
                              ↑                  |
                              └── Build failed? ─┘ (auto-loop)
```

**Key constraint:** coder runs autonomously without stopping for confirmation prompts. If the build fails, it reads the error, patches the code, and retries automatically — until the build passes or the max-step limit is reached.

## Tool Set

| Tool | Description |
|------|-------------|
| `read_file` | Read a file with line numbers |
| `write_file` | Overwrite/create a file |
| `edit_file` | Find-and-replace (unique match required) |
| `list_files` | Recursive directory listing |
| `run_command` | Execute any shell command |

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODER_API_KEY` | — | API key (required) |
| `CODER_MODEL` | `gpt-4o-mini` | Model name |
| `CODER_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `CODER_BUILD_CMD` | auto-detected | Build/compile command |
| `CODER_MAX_STEPS` | `40` | Max loop iterations before giving up |
| `CODER_PERMISSION` | `auto` | Permission mode: `auto` \| `ask` \| `readonly` |
| `CODER_STREAM` | `1` | `0` to disable streaming LLM output |
| `CODER_NO_APIKEY_WARNING` | — | Set to `1` to suppress the apiKey-in-rc warning |

### Per-project config file

Create `.coderrc.json` in your project root (see `.coderrc.example.json`):

```json
{
  "model": "gpt-4o",
  "baseUrl": "https://api.groq.com/openai/v1",
  "buildCmd": "npm test",
  "maxSteps": 60,
  "permissions": {
    "mode": "ask",
    "allowCommands": ["npm ", "git ", "npx "],
    "denyCommands": ["curl ", "wget "]
  }
}
```

> ⚠️ **Security:** never put `apiKey` in `.coderrc.json` — it may be committed to git. Use `CODER_API_KEY` env var instead. A pre-commit check is available at `scripts/check-secrets.mjs`.

## Permissions & Safety

coder ships with a layered permission system for `run_command`:

| Mode | Behavior |
|------|----------|
| `auto` (default) | Autonomous — runs shell commands without confirmation (original behavior) |
| `ask` | Prompts before each shell command not covered by `allowCommands` |
| `readonly` | Shell commands are disabled entirely; the agent can only read/list files |

Layered checks, in order:

1. **Catastrophic deny list** — `rm -rf /`, `dd of=/dev/...`, fork bombs, `curl | sh`, etc. are **always denied**, in every mode.
2. **`denyCommands`** (config) — always denied.
3. **Session allowlist** — commands you approved with `[a] always allow` in this session.
4. **`allowCommands`** (config) — auto-approved.
5. **Mode** — `auto` runs everything else; `ask` prompts; `readonly` denies.

In `ask` mode the prompt offers `[y] yes / [a] always allow "<prefix>" / [n] no / [q] quit`. With `-y` (non-interactive), commands needing confirmation are denied instead of hanging CI.

## MCP Servers (stdio)

coder can use tools from [MCP](https://modelcontextprotocol.io) servers configured in `.coderrc.json`:

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

## Sessions

Every run auto-saves its state (messages, steps, build result) to `.coder/sessions/<id>.json` after each step. If the run is interrupted (Ctrl+C, crash, max steps), you can continue where it left off:

```bash
coder list                      # list saved sessions
coder resume last               # continue the most recent session
coder resume <id> "follow-up"   # resume + add a new instruction
```

Sessions older than 7 days are pruned automatically on the next run. Use `--no-save` to disable (e.g. in CI).

## Streaming

LLM output is streamed token-by-token by default (`CODER_STREAM=0` to disable). If a provider doesn't support streaming, coder automatically falls back to non-streaming requests.

## Logging

Enable a structured JSONL event log with `--log-file` (or `CODER_LOG_FILE=1`, or `CODER_LOG_FILE=/path/to/log.jsonl`):

```bash
coder --log-file "fix the failing test"
cat .coder/logs/<session-id>.jsonl | jq 'select(.type == "error")'
```

Events: `step` (with token usage), `tool` (args, ok, elapsedMs, denied reason), `build`, `finish`. One JSON object per line — pipe to `jq` or any log consumer.

## Reliability

Transient LLM API failures (HTTP 429/5xx, network errors) are retried automatically with exponential backoff and jitter (up to 3 retries, honoring `Retry-After`). Client errors (401/403/404) fail fast. Both OpenAI-compatible and Anthropic native providers are supported — Anthropic is auto-detected from the model name (`claude-*`) or base URL.

### Auto-detected build commands

coder detects the build command automatically:

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
coder [options] "<task>"     Run a task autonomously until the build passes
coder                       Start interactive session
coder --help | --version     Help and version
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
| `--provider <name>` | `openai` \| `anthropic` (env CODER_PROVIDER; auto-detected) |
| `--no-save` | Disable session auto-save to `.coder/sessions/` |

## Examples

```bash
# Run a task (auto-saves session to .coder/sessions/)
coder -B "npm test" "fix the null pointer in UserService"

# Resume after a crash or interrupt
coder resume last "now add unit tests for the fix"

# Interactive mode with permission guard
coder --permission ask "npm install express and wire up a route"

# Custom LLM (Groq, Ollama, vLLM, OpenRouter…)
coder --base-url https://api.groq.com/openai/v1 -k $GROQ_KEY \
  "add input validation to the CLI"

# Anthropic (auto-detected when model starts with 'claude-')
coder -m claude-sonnet-4-5 "refactor the parser module"

# CI: non-interactive, no session saving
coder --no-save -y "run the full migration"
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  CLI (src/index.ts)                         │
│   arg parsing, REPL, SIGINT handling        │
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│  Agent (src/agent.ts)                       │
│   Closed-loop orchestrator                  │
│   history trimming, error injection         │
└───────┬───────────────────────┬─────────────┘
        │                       │
┌───────▼───────┐    ┌─────────▼──────────┐
│  LLM Client   │    │  Tool Registry       │
│ (src/llm.ts)  │    │ (src/tools.ts)       │
│ OpenAI compat │    │ read/write/run/list │
└───────────────┘    └──────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│  Build Checker (src/build.ts)               │
│   run build → exit 0 = stop condition met   │
└─────────────────────────────────────────────┘
```

## Integration Testing

```bash
npm test          # or: node test/run-e2e.mjs
```

This spins up a mock LLM server and verifies the closed-loop works:
1. Agent writes buggy code
2. Build fails → agent patches it
3. Build succeeds → agent finishes

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Task completed — build passed |
| `1` | Build failed after max steps |
| `2` | Fatal error (no API key, network error, etc.) |

## License

MIT
