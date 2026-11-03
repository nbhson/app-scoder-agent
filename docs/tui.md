# TUI Guide — Mission Control

Full-screen terminal UI built with [Ink](https://github.com/vadimdemedes/ink) (React for terminals).

## Starting TUI

```bash
scoder tui                     # interactive session
scoder tui "fix the bug"       # auto-submit initial task
```

## Layout

```
┌─ Build Rail ───────────────────────────────────────────────────────────┐
│ ⚑ scoder   ● build ok   auto   ▰▰▰▰▱▱▱▱▱▱  step 12/40                  │
├─ Phase + Metrics ──────────────────────────────────────────────────────┤
│ plan › explore › edit › build › verify    tok 4.2k→1.1k  ·  89 tok/s │
├─ Chat Pane ────────────────────────────────────────────────────────────┤
│ you>  fix the null pointer                                            │
│                                                                    ▋  │
│ 03▸ agent  Reading src/user.ts...                                     │
│ 03▸ ✎ write_file  src/user.ts  +3 -1                                   │
│ 03▸ ⚙ run_command  npm run build                                      │
│         ├── npm run build                                             │
│         └── ✓ 2s                                                      │
├─ Status Bar ───────────────────────────────────────────────────────────┤
│ gpt-4o-mini  ·  step 12  ·  scroll: 40%                               │
└───────────────────────────────────────────────────────────────────────┘
```

## Features

### Build Rail (Top Bar)
- **Brand** — ⚑ scoder logo
- **Build Lamp** — ● build ok / ○ build fail / ◌ no build yet
- **Permission Mode** — auto / ask / readonly
- **Step Gauge** — ▰▰▰▱▱▱▱▱▱▱ (fills as budget burns)

### Chat Pane
- User messages with timestamps
- Streaming assistant text (live cursor ▋)
- Tool calls with status (`✔`/`✘`, spinner while running)
- Diff cards (`✎`) for file writes/edits
- Flight-recorder step prefix (`03▸`)
- Live command output (dimmed block)

### Phase Breadcrumb
`plan › explore › edit › build › verify` — current phase highlighted

### Live Metrics
- Tokens in → out
- tok/s (throughput)
- Elapsed time
- Guardrail interventions

### Status Bar
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
| `Esc` | Return to live tail / Abort |
| `Ctrl+C` | Quit |

## Slash Commands

Same commands available in TUI and REPL:

| Command | Description |
|---------|-------------|
| `/help` | Command list |
| `/clear` | Reset conversation |
| `/cost` | Token usage |
| `/model` | Model info |
| `/skills` | List skills |
| `/skill <name>` | Load a skill |
| `/mcp` | MCP servers & tools |
| `/review <prompt>` | Prompt gate |
| `/permission <auto\|readonly>` | Switch mode |
| `/exit` | Quit |

## Themes

TUI supports 3 built-in themes + custom terminal detection:

```bash
scoder tui --theme dark   # Dark theme (default if terminal supports)
scoder tui --theme light  # Light theme
scoder tui --theme mono   # Monochrome
```

## Non-TTY Fallback

When stdout is not a terminal (CI, pipes), TUI automatically falls back to the classic REPL.

```
$ scoder tui "fix the bug" | tee log.txt
# Falls back to REPL output (no alt-screen)
```