# TUI Guide — Mission Control

**Version 0.9.6** — rich display, responsive rendering, chart and timeline support.

Full-screen terminal UI built with [Ink](https://github.com/vadimdemedes/ink) (React for terminals).

## Starting TUI

```bash
scoder tui                     # interactive session
scoder tui "fix the bug"       # auto-submit initial task
```

## Layout

```
 ⚑ scoder (v…)   plan › explore › edit › build › verify        [auto] ✓ ok
────────────────── Build Rail (app bar, thin divider) ─────────────────────
 ┌─ Chat Pane ───────────────────────────────────────────────────────────┐
 │ │ you ▸ fix the bug                                                   │
 │  ◆ agent — markdown answer…                                        ▋  │
 │  03 ▸ 📖 read_file  src/user.ts · 0.4s                                │
 │  ╭─ 05 ▸ ✎ +3 -1  src/user.js ──────────────────────────────────╮     │
 │  │ @@ -10,3 +10,5 @@ …colored diff…                            │  │
 │  ╰───────────────────────────────────────────────────────────────╯     │
 │  07 ▸ ⚡ run_command  npm run build · 1.2s                              │
 │    └ ✓ build passed                                                   │
 └───────────────────────────────────────────────────────────────────────┘
────────────────── Status Bar (app bar, thin divider) ────────────────────
 ⠙ running · gpt-4o-mini          ⏎ send · ctrl+s sessions · ctrl+c quit
                            ┌─ Sidebar (≥100 cols) ─┐
                            │ ─ SESSION ──────────  │
                            │   model …             │
                            │   dir …               │
                            │ ─ METRICS ──────────  │
                            │   steps ▰▱▱… 3/40     │
                            │   toks …              │
                            │   speed …             │
                            │   ctx …               │
                            │   elapsed …           │
                            │ ─ PHASES ───────────  │
                            │   ◆ explore …         │
                            │ ─ BUILD ────────────  │
                            │   ● build ok          │
                            │ ─ MCP ──────────────  │
                            │   ● fs ready          │
                            │ ─ PLAN ─────────────  │
                            │   1/3 steps           │
                            │   ✔ read lib.js       │
                            │   ◆ fix add()         │
                            │   ○ run build         │
                            └───────────────────────┘
```

## Features

### Build Rail (Top Bar — app-bar style)
- **Thin bottom divider** instead of a full heavy box — the brand row floats
  over a single hairline rule, saving one terminal row and matching the
  Status Bar at the bottom (which mirrors it with a top divider)
- **Brand** — ⚑ scoder logo
- **Permission Mode** — [auto] / [ask] / [readonly]
- **Build Lamp** — ✓ ok / ✗ fail / ○ — (no build yet)
- **Guardrail notice** — spans the full available header width inline when a
  guardrail fires (e.g. `⚠ trả lời text chưa dùng tool — nhắc tiếp tục`);
  otherwise the phase breadcrumb (`plan › explore › edit › build › verify`)
- **Note:** step count (`x/40`) and elapsed time are NOT in the header/footer —
  they live in the sidebar METRICS section only (avoiding duplication)

### Chat Pane
- User messages with a left accent border (`│`, theme `user` color) + `you ▸`
  label (bold) — clean and scannable, no full-width background block
- Streaming assistant text (live cursor ▋)
- Tool calls with status (`✔`/`✘`, spinner while running)
- Diff cards (`✎`) for file writes/edits
- Flight-recorder step prefix (`03 ▸`)
- Live command output (dimmed block)
- Rich assistant display is terminal-native and dependency-free:
  - GFM tables use measured pane width, bounded cells, Unicode borders, and
    remain readable on narrow terminals instead of forcing horizontal overflow.
  - ` ```chart ` fences render bar charts by default; use `chart:line` or
    `chart:pie` for alternate views. Data accepts JSON or one `label | value`
    row per line.
  - ` ```timeline ` (also ` ```events `) renders a vertical event rail. Data
    accepts JSON arrays/`{"events": [...]}` or `time | title | detail | status`
    rows. Status values are `done`, `active`, `pending`, or `error`.
  - Empty/invalid rich blocks show a compact fallback instead of crashing the
    transcript. All rich content is capped and clipped to the current pane.

#### Rich display examples

```chart:bar
{"title":"Weekly builds","data":[{"label":"Mon","value":4},{"label":"Tue","value":7}]}
```

```timeline
2026-11-06 09:00 | Plan | inspect repository | done
2026-11-06 09:12 | Implement | update renderer | active
2026-11-06 09:30 | Verify | run tests | pending
```

The renderer intentionally uses Ink primitives and Unicode rather than a web
chart package: it works in SSH/PTY/CI terminals, respects the existing theme,
and avoids increasing startup cost or introducing a browser-only dependency.

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
- On narrow terminals (< 100 cols) the sidebar is hidden and the BuildRail falls back
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
| `/help` | Command list (builtin + custom) |
| `/agent` | List/select primary agents |
| `/init` | Create AGENTS.md template |
| `/theme` | Switch palette |
| `/clear` | Reset conversation |
| `/compact` | Summarize older history |
| `/cost` | Token usage |
| `/model` | Model info |
| `/skill [name]` | List skills; with a name, load it |
| `/mcp` | MCP servers & tools |
| `/permission <mode>` | Switch mode |

Sessions are resumed via the **Ctrl+S** session picker; quit with `exit` or
**Ctrl+C**.

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
