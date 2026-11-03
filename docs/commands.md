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
scoder cost [--last <n>]     Token usage & estimated cost
scoder models [provider]     Model catalog (context window, pricing)
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
| `PgUp / PgDn` | Scroll the chat pane |
| `Home / End` | Jump to bottom / top |
| `Esc` | Return to live tail (when scrolled up) / abort task |
| `Ctrl+C` | Quit (press twice to confirm) |

## Slash Commands (REPL/TUI)

| Command | Description |
|---------|-------------|
| `/help` | Show command list |
| `/clear` | Reset conversation + agent context |
| `/cost` | Session token usage |
| `/model` | Active model/provider/build |
| `/skills` | List discovered skills |
| `/skill <name>` | Stage a skill for the next task |
| `/mcp <server> <tool>` | List/execute MCP tools |
| `/review <prompt>` | Prompt gate: rewrite, review, approve |
| `/permission <mode>` | Switch permission mode |
| `/exit` | Quit |

## @file Mentions

Prefix any path with `@` to inline file content into the agent's context:

```bash
scoder "fix the bug in @src/agent.ts"
scoder "refactor @src/handlers/ and update @README.md"
```

- `@src/file.ts` — file content injected
- `@"path with spaces.ts"` — for paths containing spaces
- `@src/dir/` — directory listing injected
