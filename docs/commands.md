# CLI Commands & Flags

## Commands

```bash
scoder [options] "<task>"     Run a task autonomously until the build passes
scoder                       Start interactive session (REPL)
scoder init                  First-run wizard — writes .scoderrc.json + tests connection
scoder tui [task]            Full-screen terminal UI (Mission Control)
scoder serve [--port]        HTTP server mode — POST tasks, stream progress via SSE
scoder list                  List saved sessions
scoder resume <id|last>      Resume a saved session
scoder logs [id|last]        View session's JSONL log
scoder cost [--last <n>] [--router]  Token usage & estimated cost
scoder models [provider]     Model catalog (context window, pricing)
scoder mcp <list|add|remove|test|import>   MCP server management
scoder trust [path|--list|--revoke <path>]   Project-config trust
scoder --version | --help    Version and help
```

## Options

| Flag | Description |
|------|-------------|
| `-m <model>` | Model to use |
| `--base-url <url>` | OpenAI-compatible API base URL |
| `-k <key>` | API key |
| `-B, --build <cmd>` | Build command (stop condition) |
| `-d, --dir <path>` | Working directory |
| `-s, --max-steps <n>` | Max iterations (default 40) |
| `--permission <mode>` | `auto` \| `ask` \| `readonly` |
| `-y` | Non-interactive mode (auto-approve commands) |
| `--provider <name>` | `openai` \| `anthropic` |
| `--no-save` | Disable session auto-save |
| `--log-file` | Write JSONL event log |
| `--port <n>` | (`serve`) TCP port |
| `--host <addr>` | (`serve`) Bind address |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## Project Config Trust (`scoder trust`)

Project-local config (`.scoderrc.json`, `.scoder/permissions.local.json`) from
an untrusted directory has its sensitive fields — `baseUrl`, `apiKey`,
`providers`, `mcpServers`, `buildCmd`, `verifyCmds`, `formatter`,
`permission`, `permissions`, `sandbox`, `shellEnvAllow` — dropped on first
use, with a warning. Approve a directory once:

```bash
scoder trust                      # the current directory
scoder trust ~/work/repo          # any path
scoder trust --list               # list trusted directories
scoder trust --revoke ~/x         # withdraw
```

Stored in `~/.scoder/trust.json`. For one-off automation, `SCODER_TRUST_PROJECT=1`
accepts the current directory for a single run without persisting. Global/user
config (`~/.scoder/config.json`) is never filtered.

## Examples

```bash
# Run a task
scoder "fix the null pointer in UserService"

# Resume after crash
scoder resume last "now add unit tests"

# Interactive with permission guard
scoder --permission ask "npm install express and wire up a route"

# Custom LLM
scoder --base-url https://api.groq.com/v1 -k $GROQ_KEY "add validation"

# HTTP server
scoder serve --port 4114
curl -X POST localhost:4114/api/runs -d '{"task": "fix the bug"}'
curl -N localhost:4114/api/runs/<id>/events    # SSE stream

# CI mode
scoder --no-save -y "run the migration"
```

## TUI Keybinds

| Key | Description |
|-----|-------------|
| `Ctrl+S` | Open session picker — browse and resume saved sessions |
| `Ctrl+T` | Toggle thinking/reasoning stream visibility |
| `↑ / ↓` | Recall message history |
| `PageUp` / `PageDown` | Scroll the chat pane |
| `Home / End` | Jump to bottom / top |
| `Esc` | Return to live tail (when scrolled up) / abort task |
| `Ctrl+C` | Quit (press twice to confirm) |

## Slash Commands (REPL/TUI)

| Command | Description |
|---------|-------------|
| `/help` | Show command list (builtin + custom) |
| `/agent` | List/select primary agents (build/plan/review/custom) — **Shift+Tab** cycles the built-ins in the TUI |
| `/init` | Create an AGENTS.md template in this project |
| `/theme` | Switch palette (TUI) — persist the default via `theme` in the config file |
| `/clear` | Reset conversation + agent context |
| `/compact` | Summarize older history now (manual compaction) |
| `/btw <question>` | Side question answered from session context — no tools, kept out of history; works while a task runs |
| `/cost` | Session token usage |
| `/model` | Active model/provider/build; `/model auto` enables routing, `/model <provider/model>` pins |
| `/router` | Model router status: mode, tiers, last decision, judge layer (needs `router.enabled`) |
| `/skill [name]` | List discovered skills; with a name, stage it for the next task |
| `/mcp` | MCP servers & tools: `/mcp [server] [tool] [json\|text]` |
| `/permission <mode>` | Switch permission mode — **Shift+P** cycles auto/ask/readonly in the TUI (input empty) |
| `/shortcut` | All TUI keybindings in the full-screen viewer (TUI only; aliases `/shortcuts`, `/keys`) |

Sessions are managed with `scoder list` / `scoder resume` (CLI) or the
**Ctrl+S** session picker (TUI). Quit with `exit`, `quit`, or **Ctrl+C**.

### Side questions (`/btw`)

`/btw <question>` answers a quick question from the current session context
without polluting the main conversation: a single tool-less LLM call over a
read-only snapshot of the history — neither question nor answer is appended to
the conversation, and the provider-side prompt cache stays warm. In the TUI it
works while a task is running (the run loop never sees the exchange). Usage is
counted toward `/cost`; bare `/btw` re-shows the last answer (session-only).

## Custom Commands

Project-level custom slash commands are discovered from `.scoder/commands/*.md`
(with optional YAML frontmatter). They appear in `/help` and tab completion
alongside builtins.

## @file Mentions

Prefix any path with `@` to inline file content into the agent's context:

```bash
scoder "fix the bug in @src/agent.ts"
scoder "refactor @src/handlers/ and update @README.md"
```

- `@src/file.ts` — file content injected
- `@"path with spaces.ts"` — for paths containing spaces
- `@src/dir/` — directory listing injected
