# TUI Guide — Mission Control

Full-screen terminal UI built with [Ink](https://github.com/vadimdemedes/ink) (React for terminals).

## Starting TUI

```bash
scoder tui                     # interactive session
scoder tui "fix the bug"       # auto-submit initial task
```

## Layout

```
┌─ Build Rail (single row) ──────────────────────────────────────────────┐
│ ⚑ scoder   [auto] ✓ ok    ⚠ <guardrail notice, full width>            │
├─ Chat Pane ────────────────────────────────────────────────────────────┤
│ ┌──────────────┐                                                      │
│ │ you ▸        │                                                      │
│ │ fix the bug  │                                                      │
│ └──────────────┘                                                      │
│                                                                    ▋  │
│ 03▸ agent  Reading src/user.ts...                                     │
│ 03▸ ✎ write_file  src/user.ts  +3 -1                                   │
│ 03▸ ⚙ run_command  npm run build                                      │
│         ├── npm run build                                             │
│         └── ✓ 2s                                                      │
├─ Status Bar ───────────────────────────────────────────────────────────┤
│ gpt-4o-mini  ·  step 12  ·  scroll: 40%                               │
└───────────────────────────────────────────────────────────────────────┘
                            ┌─ Sidebar (≥92 cols) ─┐
                            │ ─ SESSION           │
                            │   model …           │
                            │   dir …             │
                            │ ─ METRICS           │
                            │   steps ▰▱▱… 3/40   │
                            │   toks …            │
                            │   speed …           │
                            │   ctx …             │
                            │   elapsed …         │
                            │ ─ PHASES            │
                            │   ◆ explore …       │
                            │ ─ BUILD             │
                            │   ● build ok        │
                            │ ─ MCP               │
                            │   ● fs ready        │
                            │ ─ PLAN              │
                            │   1/3 steps         │
                            │   ✔ read lib.js     │
                            │   ◆ fix add()       │
                            │   ○ run build       │
                            └─────────────────────┘
```

## Features

### Build Rail (Top Bar — single row)
- **Brand** — ⚑ scoder logo
- **Permission Mode** — [auto] / [ask] / [readonly]
- **Build Lamp** — ✓ ok / ✗ fail / ○ — (no build yet)
- **Guardrail notice** — spans the full available header width inline when a
  guardrail fires (e.g. `⚠ trả lời text chưa dùng tool — nhắc tiếp tục`);
  otherwise the phase breadcrumb (`plan › explore › edit › build › verify`)
- **Note:** step count (`x/40`) and elapsed time are NOT in the header/footer —
  they live in the sidebar METRICS section only (avoiding duplication)

### Chat Pane
- User messages with a full colored border + `you ▸` label (bold) so they stand
  out from agent output at a glance
- Streaming assistant text (live cursor ▋)
- Tool calls with status (`✔`/`✘`, spinner while running)
- Diff cards (`✎`) for file writes/edits
- Flight-recorder step prefix (`03▸`)
- Live command output (dimmed block)

### Phase Breadcrumb
`plan › explore › edit › build › verify` — current phase highlighted

### Sidebar (≥92 columns)
- **SESSION** — model + workdir (no permission line; permission stays in the header)
- **METRICS** — step fuel gauge (`▰▰▰▱▱▱▱▱▱▱`), tokens in→out, tok/s, ctx with
  input/limit (pct%), cost, elapsed, guardrail count
- **PHASES** — plan › explore › edit › build › verify (current phase highlighted)
- **BUILD** — build lamp + build command
- **MCP** — per-server state (ready / connecting / reconnecting / dead)
- **PLAN** — top of the sidebar (right after SESSION); live checklist from `write_todos` (✔/◆/○);
  resets in real time on each new user message so the previous task's plan doesn't linger
- On narrow terminals (< 92 cols) the sidebar is hidden and the BuildRail falls back
  to showing the phase breadcrumb + metrics inline

### Status Bar
- Status icon + status (running / success / failed / aborted / idle) — no step count or elapsed time (those live in the sidebar)
- Model name
- Scroll position
- Keybind hints

## Keybinds

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `↑/↓` | Recall message history |
| `Tab` | Autocomplete (commands, skill names, MCP tools) |
| `PgUp/PgDn` | Page scroll (0.8 viewport) |
| `Home/End` | Jump to top/bottom |
| `Esc` | Return to live tail / Abort / enter vim normal mode in input |
| `Ctrl+C` | Quit |
| `Ctrl+P` | Open command palette |
| `Ctrl+S` | Open session picker |
| `?` | Show help modal |
| Mouse wheel | Scroll chat pane |

## Slash Commands

Same commands available in TUI and REPL:

| Command | Description |
|---------|-------------|
| `/help` | Command list |
| `/plan` | Show current plan |
| `/agent` | List/select primary agents |
| `/init` | Create AGENTS.md template |
| `/sessions` | List/resume sessions |
| `/diff` | Show diffs |
| `/theme` | Switch palette |
| `/clear` | Reset conversation |
| `/compact` | Summarize older history |
| `/cost` | Token usage |
| `/model` | Model info |
| `/skills` | List skills |
| `/skill <name>` | Load a skill |
| `/mcp` | MCP servers & tools |
| `/review <prompt>` | Prompt gate |
| `/permission <mode>` | Switch mode |
| `/undo` | Revert files |
| `/commands` | List all commands |
| `/export [md\|json]` | Export transcript |
| `/search <query>` | Search transcript |
| `/exit` | Quit |

## Themes

TUI supports 6 built-in palettes (mission, paper, mono, light, high-contrast, solarized)
plus terminal capability detection and a project default via `.scoder/theme.json`:

```bash
# In the TUI:
/theme list
/theme mission
/theme high-contrast
```

## Non-TTY Fallback

When stdout is not a terminal (CI, pipes), TUI automatically falls back to the classic REPL.

```
$ scoder tui "fix the bug" | tee log.txt
# Falls back to REPL output (no alt-screen)
```