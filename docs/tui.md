# TUI Guide — Mission Control

**Version 0.9.7** — rich display, responsive rendering, chart and timeline support.

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
- **Git context** — `⎇ main · ±3` (branch + dirty entry count) sits in the rail
  center while idle. It comes from an async, time-boxed `git status --porcelain -b`
  probe (never `spawnSync`, never blocks a frame): refreshed on mount, every 5 s
  while idle and right after a run finishes. Hidden entirely outside a git repo
  or when the probe fails; while a run is active (or a guardrail owns the
  center) the chip relocates to the left of the Status Bar, and it is dropped
  rather than overflowing when there is no room (P7).
- **Note:** step count (`x/40`) and elapsed time are NOT in the header/footer —
  they live in the sidebar METRICS section only (avoiding duplication)

### Chat Pane
- User messages with a left accent border (`│`, theme `user` color) + `you ▸`
  label (bold) — clean and scannable, no full-width background block
- Streaming assistant text (live cursor ▋)
- Tool calls with status (`✓`/`✗` marker when done, spinner while running)
- Diff cards (`✎`) for file writes/edits
- Flight-recorder step prefix (`03 ▸`)
- Live command output (dimmed block)
- Queue badge (`⇢ N`) in the status bar while steering messages await delivery;
  when the sidebar is hidden (narrow terminals) the status bar shows compact
  `ctx % · $cost` metrics instead of the key hints
- Rich assistant display is terminal-native and dependency-free:
  - GFM tables use measured pane width, bounded cells, Unicode borders, and
    remain readable on narrow terminals instead of forcing horizontal overflow.
  - ` ```chart ` fences render bar charts by default; use `chart:line` or
    `chart:pie` for alternate views. Data accepts JSON or one `label | value`
    row per line.
  - ` ```timeline ` (also ` ```events `) renders a vertical event rail. Data
    accepts JSON arrays/`{"events": [...]}` or `time | title | detail | status`
    rows. Status values are `done`, `active`, `pending`, or `error`.
  - Code fences get language-aware syntax highlighting from a table-driven
    tokenizer (`js/ts/tsx`, `python`, `go`, `rust`, `java`, `c/cpp`, `sql`,
    `bash/sh`, `json`, `yaml`, `toml` + common aliases like `py`, `rs`, `yml`,
    `mysql`). Unknown languages keep the JS rules — never a crash, never
    plain-text regression. No tree-sitter/native deps on the render hot path.
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
  - All of these are anchored to the `run_start` event, which `run()`,
    `runTurn()` **and** `resume()` emit (`emitRunBoundary()` in `src/agent.ts`).
    The reducer clears `startedAt`/`endedAt`/`usage`/`context`/tok-s there — so
    `elapsed = (endedAt ?? now) − startedAt` keeps ticking. `run_start` with
    `quiet: true` (resume) resets the anchors without appending the task again,
    because the transcript is already restored. A turn that starts without
    `run_start` renders a *frozen* sidebar: `endedAt` still holds the previous
    turn's finish timestamp.
- **PHASES** — plan › explore › edit › build › verify (current phase highlighted)
- **BUILD** — build lamp + build command
- **MCP** — per-server state (ready / connecting / reconnecting / dead)
- **PLAN** — top of the sidebar (right after SESSION); live checklist from `write_todos` (✔/◆/○);
  resets in real time on each new user message so the previous task's plan doesn't linger
- On narrow terminals (< 100 cols) the sidebar is hidden and the BuildRail falls back
  to showing the phase breadcrumb + metrics inline

### Harness Log (`Ctrl+B`)
- `Ctrl+B` toggles the sidebar between **OVERVIEW** (every section above, unchanged)
  and **HARNESS LOG** — a live ring buffer (800 rows) of *all* harness activity:
  run/step turns, LLM calls (tokens, cache, duration), tool calls, shell commands,
  file edits, build results, MCP status, subagents, guardrail hits, permission
  asks/answers, queue/compaction/context pressure, errors
- Audit format: `HH:MM:SS` clock + a fixed **kind label column** — `RUN · LLM ·
  TOOL · SHELL · FILE · BUILD · MCP · SUB · GUARD · PERM · EVT` — then the
  message. Text labels (not just glyphs) so a row is readable without color,
  in ASCII mode, and after copy/paste; the label column is colored by outcome
  (red on FAILED, green on ok/PASS). `run`, `llm`, `▸` prefixes were dropped
  from the message itself — the column already says it.
- Repeating events FOLD instead of flooding: context pressure, queue depth,
  todo status flips, warmup ticks and history trims update ONE live row and
  show `· ×N` (N events absorbed). Every event is accounted for; nothing is
  silently dropped. Streaming rows (LLM stream, shell output) keep a `… Nc NB`
  counter and merge when they finish.
- Navigation (input must be empty): `↑↓`/`jk` select, `PgUp/PgDn` scroll, `g`/`G`
  head/tail, `f` cycles the filter (`ALL → LLM → TOOL → MCP → SUB → EVT`), `d`
  toggles the DETAIL panel (counters + payload pointer), `⏎` opens the **full
  payload in the viewer** (resolved from the transcript; evicted payloads fall
  back to `.scoder/logs/<session>.jsonl`), `F` dumps the **whole filtered log**
  into the full-screen viewer (wide rows — commands and args are not truncated
  like the 46-cell sidebar), `y` copies the entry (OSC 52, or saves to
  `.scoder/views/`), `Esc` closes DETAIL → OVERVIEW → tail
- `/log [cat]` prints the same (filtered) log into the viewer — works on
  narrow terminals where the sidebar tab is unreachable (`cat` ∈
  `ALL|LLM|TOOL|MCP|SUB|EVT`)

### Full-screen Viewer (`v`)
- Every "… truncated" in the transcript has an escape hatch: `v` opens the
  newest tool output or diff in a full-height pane (the newest 30 documents
  are stacked — `Tab`/`Shift+Tab` cycles through them)
- Diffs render with **word-level highlighting** (common prefix/suffix dimmed,
  only the changed words on a background — `w` toggles raw unified mode)
- `y` saves the full text to `.scoder/views/<timestamp>.txt`
- Wheel, `↑↓`/`jk`, `PgUp/PgDn`, `Home/End` (`g`/`G`) scroll; `q`/`Esc` closes.
  While open, the viewer owns the keyboard — transcript keybinds don't leak in.

### Command Palette (`Ctrl+P`)
- One search line over grouped actions: builtin + custom slash commands,
  agents, themes, permission modes, and the session picker
- Fuzzy ranking (label weighted above description), `↑↓` select, `⏎` invokes
  through the same registry path as typing the command (all gates apply)

### Status Bar
- Status icon + status (running / success / failed / aborted / idle) — no step count or elapsed time (those live in the sidebar)
- Model name
- Scroll position
- Keybind hints

### Desktop Notification (`notify`)
- When a run finishes (`success` / `failed`, never `aborted`) **while the
  terminal is not focused**, scoder emits an OSC 777 notification
  (`SCoder · done · 4 steps · 1m05s · <summary>`) — iTerm2, kitty and
  VTE-family terminals show it; others ignore the escape harmlessly
  (`src/tui/notify.ts`).
- Focus state comes from DEC 1004 focus reporting (`CSI ?1004h`), enabled
  only when stdin is in raw mode on a real TTY. The sequences are observed at
  the raw-stdin layer and never reach the input line.
- Terminals that never report focus fall back to a duration rule: notify when
  the run took **> 45 s**, so long builds page you even on plain consoles.
- Control characters are stripped from the LLM summary before it goes into
  the escape — notification text can never inject further sequences.
- Off switches: `"notify": false` in `.scoderrc.json`, or `SCODER_NOTIFY=0`
  (env wins over rc). Nothing is emitted on non-TTY / `TERM=dumb` output.

## Keybinds

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | Insert a newline (multi-line input; continues with `⏎ send` on the last line) |
| `Shift+Tab` | Cycle primary agent build→plan→review (dispatches `/agent`; idle-only, resets the conversation) |
| `Shift+P` | Cycle permission mode auto→ask→readonly (dispatches `/permission`; only when the input is empty — otherwise it types a capital `P`) |
| `↑/↓` | Recall message history |
| `Tab` | Autocomplete (commands, skill names, MCP tools) |
| `PgUp/PgDn` | Page scroll (0.8 viewport) |
| `Home/End` | Jump to top/bottom |
| `Esc` | Return to live tail / Abort / enter vim normal mode in input |
| `Ctrl+C` | Quit |
| `Ctrl+P` | Open command palette (fuzzy search over commands, agents, themes, permission modes) |
| `Ctrl+B` | Toggle sidebar tab OVERVIEW ⇄ HARNESS LOG (log keys live when input is empty — see Harness Log) |
| `F` | On the LOG tab with empty input: dump the whole filtered log into the full-screen viewer |
| `Ctrl+S` | Open session picker |
| `v` | Full-screen viewer for the newest tool output / diff (only when the input is empty) |
| `?` | Show help modal |
| Mouse wheel | Scroll chat pane (or the open viewer) |

**Reading while the agent works.** Scrolled up from the bottom, the chat pane
gains two affordances: a `▼ +N new lines` pill above the input while the run
keeps producing below the fold, and a thin proportional scrollbar on the
right edge of the pane (hidden in select mode so it can't be copied as text).

**Modified-Enter terminal support.** `Shift+Enter` is only distinguishable from
`Enter` when the terminal reports modifiers. The TUI negotiates the
[kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)
at startup (`render({ kittyKeyboard: { mode: "auto" } }` — a `CSI ?u` query,
200 ms timeout, silently ignored by unsupporting terminals). Universal
fallbacks that work in every terminal: `Alt+Enter`, `Ctrl+J`, and any terminal
that sends a bare `\n` for Shift+Enter (e.g. iTerm2's default binding).
On terminals that send a plain `\r` with no modifier info, Shift+Enter behaves
like Enter.

## Slash Commands

Same commands available in TUI and REPL:

| Command | Description |
|---------|-------------|
| `/help` | Command list (builtin + custom) |
| `/agent` | List/select primary agents (⇧Tab cycles build/plan/review) |
| `/init` | Create AGENTS.md template |
| `/theme` | Switch palette |
| `/log` | Harness log in the full-screen viewer: `/log [llm\|tool\|mcp\|sub\|sys]` (TUI only) |
| `/clear` | Reset conversation |
| `/compact` | Summarize older history |
| `/cost` | Token usage |
| `/model` | Model info |
| `/skill [name]` | List skills; with a name, load it |
| `/mcp` | MCP servers & tools |
| `/permission <mode>` | Switch mode (⇧P cycles auto/ask/readonly) |

Sessions are resumed via the **Ctrl+S** session picker; quit with `exit` or
**Ctrl+C**.

## Themes

TUI supports 6 built-in palettes (mission, paper, mono, light, high-contrast, solarized).
Default resolution order: `.scoder/theme.json` (project — also accepts inline color
overrides) > `SCODER_THEME` env > `theme` key in the config file (`.scoderrc.json` /
`~/.scoder/config.json`, or the `--theme` flag) > terminal capability detection:

```jsonc
// .scoderrc.json
{ "theme": "solarized" }
```

```bash
# In the TUI:
/theme list
/theme mission
/theme high-contrast
```

`/theme <name>` hot-swaps for the current session only — persist it via the config key.

## Non-TTY Fallback

When stdout is not a terminal (CI, pipes), TUI automatically falls back to the classic REPL.

```
$ scoder tui "fix the bug" | tee log.txt
# Falls back to REPL output (no alt-screen)
```
