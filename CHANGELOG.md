# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [1.7.0] — 2026-11-27

Runs can no longer end with the session's stale greeting, an echo of an earlier
answer or a half sentence: the working-memory goal is refreshed every turn (and
on `--resume`), the new `stale-answer` guardrail retries once and otherwise fails
the run while returning the best complete answer from history, and `finish_reason`
is read from `choices[0]` so token-truncated replies are continued instead of
confirmed. The full-screen viewer moved off the bare `v` key onto the `/view`
command.

### Fixed

- **A run could finish with the session's stale greeting instead of an answer.** The
  working-memory ledger survives REPL turns by design, but its `goal` was written once
  at session start; `run-loop` folds that ledger into the conversation every 6 steps, so
  a session opened with "chào" kept being told `goal: chào` and answered a multi-step
  `web_fetch` research run with… the greeting — logged as `success: true`
  (`~/.scoder/sessions/20261127-104714-602d`, `20261127-105851-7fb8`). `setMemoryGoal()`
  refreshes the goal per turn and per `/steer` while keeping decisions, files and
  failures; `goalFromTask()` truncates from the **tail** so the newest request wins;
  `memoryFromMessages()` ignores harness blocks (repo map, ledger fold, reminders) when it
  reconstructs a goal; `--resume` takes the goal from history, not the archived task. The
  injected block now also declares itself as context rather than a user request.
- **New `stale-answer` guardrail: degenerate final text no longer counts as a result.**
  A tool-less step whose text is a strict prefix of an earlier answer
  (`restarted-answer`), an exact echo of an earlier answer after the run has already
  called tools (`stale-echo`), or an unfinished sentence (`truncated`) gets **one**
  retry reminder; a second consecutive hit **fails the run** and returns the best
  complete answer from history instead of the junk. While a retry is pending, no other
  rule may close the run with `success: true` — including `chat-done`, so a marker cannot
  smuggle a cut-off sentence past the check (20261127-103715-f250 ended on `"Dưới"`,
  3 output tokens, cached 28786/28806).
- **`finish_reason` was read from the wrong place, so token-truncated replies looked
  complete.** OpenAI-compatible servers report the stop reason in
  `choices[0].finish_reason` (a sibling of `message`); the non-stream adapter only looked
  inside `message`, so every `"length"` truncation came back as `"stop"` — and the loop
  never consulted `stop_reason` anywhere anyway. It now reuses the H-09 continuation path:
  push the partial answer, tell the model to continue exactly where it stopped (max 2× per
  run), log `step_truncated`. Ollama speaks the same OpenAI-compatible `/v1` surface, and
  the Anthropic adapter now carries `stop_reason` (`"max_tokens"`) on its non-stream path
  too — previously only the stream parser had it.
- `scripts/check-docs.mjs` used `new URL("..", import.meta.url).pathname`, which on
  Windows yields `/D:/…` → `resolve()` produced `D:\D:\…`, so `npm run docs:check` died on
  `ENOENT` **without verifying a single path**. Now uses `fileURLToPath` (31 paths verified).

### Added

- `test/guardrails-degenerate.test.mjs` (unit: helpers, rule ladder, ordering against
  `text-only-streak`/`continue-nudge`, per-run isolation) and
  `test/stale-goal.test.mjs` (integration through `Agent` with a scripted client: goal
  refresh, echo detection, rescue summary, `stop_reason: "length"` continuation).
- `test/eval/stale-goal-echo.mjs` — eval gate "a degenerate final answer is never
  confirmed" (4 sub-scenarios, self-contained because the harness drives one turn only).
- `docs/guardrails.md`: "Degenerate answers" section with the production evidence.

### Changed

- **The bare `v` key no longer opens the full-screen viewer** (reported 2026-11-27: typing
  a task that started with `v` on an empty line popped the viewer over the transcript
  instead of accepting the character). The keybinding is removed from
  `use-keybinds.ts` and `v` left `reservedKeysRef`, so `v` types normally as the first
  character of a message and no popup can appear by itself. The escape hatch for
  "… truncated" tool output / diffs is now the tui-only command **`/view`**
  (alias `/viewer`), wired to the same `openViewer()` in `use-submit.ts` and listed in
  `/help`, Tab completion, the palette, the help modal and `/shortcut`. `Enter`/`F` on the
  LOG tab, `/log` and `/shortcut` keep opening the viewer as before.

## [1.6.1] — 2026-11-26

Version bump for the TUI diagram fixes that were folded into 1.6.0 after its
release commit (`6008b6f`), so the fix ships under its own version instead of a
moved tag. **No new code changes**: the artifact is byte-identical to 1.6.0 —
`dist/tui/markdown/graph.js` and `dist/tui/markdown/diagram.js` diff clean
against the published npm 1.6.0 tarball.

### Fixed

- Mermaid flowcharts that collapsed to the `◈ diagram preview` summary box now
  render (star graphs fit the 40-row budget via a compact sibling gap; the
  widest-label cap grew 22 → 26 so code-ish labels stay in layered mode), and
  the markdown snapshot suite is CRLF-safe on Windows checkouts — the two
  layout dead-ends and the `core.autocrlf` snapshot breakage are described in
  detail under [1.6.0].

## [1.6.0] — 2026-11-26

Doom-loop hardening: every repetition shape a local model was observed using
in production logs (cycles, key-order variants, URL-counting with identical
content, bare "I'll look it up…" turns) is now caught, and no run — parent or
subagent — ends without a real answer. Plus: mermaid flowcharts that used to
degrade to the summary box now render, and the markdown snapshot suite passes
on Windows checkouts.

### Fixed

- **Doom-loop detection now catches cyclic repetition, not just identical streaks.**
  The breaker compared the raw `name:arguments` string of consecutive batches, so
  models that repeat work as a cycle (`run command → analyse → grep → web fetch → …`)
  never tripped it, and a model that re-serialized the same JSON with different key
  order or whitespace (`{"a":1,"b":2}` vs `{ "b" : 2, "a" : 1 }`) was counted as new
  work. Local models (observed on `ornith-1.5:35b`) burned the whole `maxSteps`
  budget this way and the run ended with `reached max steps (40)` and no answer.
  `doomLoopRule` now watches three signals off a normalized call signature
  (`agent/tool-signature.ts`): consecutive streak, a period-2..4 cycle in a sliding
  window, and the same read-only call scattered across the run. First hit injects a
  reminder; a second hit (or a pattern far past the threshold) ends the run with the
  model's last answer in the summary. Mutating calls (`run_command`, `edit_file`, …)
  are excluded from the scattered counter so verify–fix loops stay legal.
- **Repeated read-only tool calls no longer re-execute.** `agent/loop-cache.ts` keeps
  successful read results per run; the second identical `read_file`/`grep`/`web_fetch`
  replays the cached output prefixed with `[DUPLICATE CALL … already ran at step N]`
  instead of paying the fetch/index cost again. The cache is dropped whenever a
  mutating tool runs.
- **The content-repeat loop is caught (`no-new-information` rule).** A real session
  log (`~/.scoder/sessions/20261126-141619-e507`) showed the model fetching
  `angular.dev/what-new/angular-22-1 … -39` — every call signature unique, every
  response the **same page**: ~40 steps and 5 minutes teaching the agent nothing,
  invisible to all signature-based detectors. The new rule measures output novelty
  (<15% unseen lines per step): N uninformative steps inject a reminder, the next
  ends the run with the model's last answer. Successful mutating tools reset it.
- **Tool-less intention steps are nudged, not finished.** `ornith-1.5:35b` opens
  turns with *"Tôi sẽ tìm hiểu những tính năng mới nhất…"* and emits nothing else;
  the chat-turn logic accepted that promise as a complete answer (`steps=1,
  success=true`). `continue-nudge` now recognizes an un-executed intention
  (Vietnamese/English markers, Unicode-safe word boundaries) and demands the actual
  tool call; genuine chat replies are untouched.
- **Mermaid flowcharts in the TUI no longer collapse to the summary box.** A real
  session (`horizon2-ui` page map: 1 hub → 8 leaves, `flowchart LR`, 9 nodes) fell
  through every layout: layered needed 42 rows for its 40-row budget, and the strip
  fallback refuses star graphs. Layered layout now tries a compact sibling gap
  (1 row, edge lanes stay conflict-free) before giving up, and the widest label cap
  grew 22 → 26 so code-ish labels (`RumApmTrackingService`,
  `getPageRoutedDetail()`) keep their longest word intact instead of dropping all
  side edges in strip mode.
- **Markdown snapshot suite is platform-independent again** (45/45 on Windows, was
  0/45): fixtures and snapshots are read with CRLF normalized (`core.autocrlf`
  checkouts changed the diagram slug — it hashes the source — and broke byte
  comparison), and the export hint path is POSIX-joined like every other rendered
  path (`-i .scoder/diagrams/…mmd` works in cmd, PowerShell and bash alike).
- **Runs never end without a result (`lastSubstantiveAnswer`).** Session logs show
  subagents returning exactly `Conversation turn complete.` or
  `Agent stopped: reached max steps (20)` to their parent — the parent had nothing
  to work with. A bare `<<CHAT_DONE>>` finish and the max-steps/interrupt paths now
  backfill the summary with the last substantive assistant answer from history.

### Tools

- `scripts/replay-guardrails.mjs` — replays every run in `~/.scoder/sessions`
  through the current engine and reports which step each breaker would cut, so
  loop fixes are validated against production logs instead of fixtures.
  Replay evidence: the incrementing-URL loop stops at step 7, the identical
  `run_command` streak at step 8, legitimate runs (7 and 12 steps) untouched.

### Tests

- 25 new cases in `test/guardrails-loop.test.mjs` (signature normalization, cycle
  detection, the three signals, escalation to finish, legal verify–fix loops) and a
  new eval scenario `test/eval/doom-cycle.mjs` (cyclic loop is caught, run stops
  early, duplicate read served from cache).
- 9 cases in `test/guardrails-noinfo.test.mjs` (content-repeat detection, intention
  recognition — including Vietnamese diacritics — and `lastSubstantiveAnswer`) plus
  eval scenarios `test/eval/no-new-info.mjs` and `test/eval/intention-nudge.mjs`.
  `npm run eval`: 16/16 scenarios.

## [1.5.1] — 2026-11-25

Patch on top of 1.5.0: mermaid flowcharts with subgraphs stop degrading to
the unreadable "N nodes · 0 edges" summary.

### Fixed

- **Standalone node definitions inside subgraphs are registered** — a lone
  `A[First]` line (no arrow) is valid mermaid, but the parser rejected
  single-token statements, so subgraph members lost their labels and shapes
  and inline-text dotted arrows like `A -. ref .-> B` failed to parse; the
  whole chart then fell back to the summary. The parser now accepts node-def
  lines, the inline dotted-text arrow (opener `-.` / closer `.-`) and the
  common `-.>` typo.
- **The fold-out summary uses the real parser** — `summarizeMermaid` now
  delegates to `parseFlowchart` when it accepts the source (flattening
  subgraphs and reading every arrow form), so the summary can't diverge from
  what the renderer draws; the regex fallback stays for oversized sources.

### Tests

- 4 new cases in `test/graph-layout.test.mjs` (node defs in subgraphs,
  inline dotted arrows, `-.>` leniency, and the regression chart).
  Full suite: 1474 pass.

## [1.5.0] — 2026-11-25

### Added

- **Diagram focus + packet animation (P2.3)** — flowcharts can now "point" at
  one node like the ROUTER tab points at a model. Declare it in the source
  (`%% focus: <id>` comment or a `:::focus` class on the node) or drive it
  live with the new **`diagram_focus`** tool: the TUI lights that node's box
  and label with the accent color and animates a packet (`◆`) riding its
  edges for one ~0.7 s burst, so the model can explain a diagram step by
  step WITHOUT re-printing it into the transcript. Consecutive focuses
  remember the previous node and the packet takes the direct lane it just
  walked. The animation shares the router's `usePulse` hook and honors the
  same kill switches (`SCODER_ANIM=0`, `SCODER_NO_MOTION=1`). Focused graphs
  route edges with lane occupancy (strict → shared-label → loose) so the
  focus fan draws as one clean pipe; unfocused graphs keep the exact classic
  ladder and render byte-identical (verified). ```chart fences accept a
  `focus` (or `active`) row label that highlights that bar with `◆`. Export
  slugs ignore focus directives, so moving the focus never duplicates the
  `.mmd` file.

### Fixed

- **Finished mermaid flowcharts no longer collapse into an unreadable
  "chain layout"** — the layout engine fell back from `layered` to `strip`
  for ANY graph that exceeded the height budget, but `strip` only draws
  edges between consecutive nodes in topological order: a branching
  diagram (e.g. the JS event loop, 16 nodes / 18 edges, 49 rows tall at
  the default routing band) lost 13 connectors and rendered as a grid of
  disconnected boxes, while the partial source during streaming still
  looked right. `layered` now tightens its routing band (3 → 2 → 1 rows)
  before giving up, and `strip` refuses graphs whose chain order would
  draw less than half the edges — those degrade to the honest structured
  summary box instead, as the module always promised.
- **Streaming no longer exports truncated `.mmd` files** — every repaint of
  an unclosed mermaid fence wrote its partial source (including the `▋`
  cursor) to `.scoder/diagrams/`, leaving dozens of invalid files per
  diagram. Open fences are marked in the Block AST and skip the export;
  the finished block still writes one clean file.
- **Double-width labels no longer stretch flowchart boxes** — a CJK glyph
  covers two grid columns, but the raster emitter also printed the reserved
  spacer as a space, so every 中文/日本語 label shifted the box borders to
  the right by one column per character. The emitter now skips continuation
  cells; the packet overlay (`paintCells`) is width-preserving across the
  whole grid for the same reason.

### Tests

- `graph-layout.test.mjs`: branching-tall regression case (drawn as a real
  layered graph, ≥14/17 edges), "never chain-lay-out a branching graph",
  strip edge-retention assertion, and the open-fence export-flag case.
  `mermaid-chain` @ 120c snapshot updated — the LR chain now fits one
  honest row instead of wrapping.
- P2.3: `graph-layout.test.mjs` gains the focus channels (`:::focus` before
  and after a shape, `%% focus:` directive, unknown-id drop), lane/pipe
  invariants, `pulseMarks` frames walking the pipe or the direct prev→focus
  lane, `paintCells` replacing exactly one glyph with row widths preserved
  (plus a full CJK-grid sweep), and `resolveFocus` match/miss rules;
  `tui-render.test.mjs` covers the chart `focus` marker, the focused
  flowchart header, focus-move export dedup, and event routing through
  `DiagramFocusContext` (only the hinted block lights); `tui-state.test.mjs`
  the `diagram_focus` reducer (prev chain, malformed args, run reset);
  `agent-v2.test.mjs` the tool itself.

## [1.4.1] — 2026-11-24

Patch on top of 1.4.0: the harness-log full-width panel experiment is
reverted — it rendered below the chat row (bottom of the screen) instead of
in the right sidebar, which read as a regression.

### Reverted

- **HARNESS LOG is back in the sidebar rail** — `LogPanel` and its app
  wiring (rail hidden while the tab is open, `logGeomRef` budget mirror,
  `inner`-aware LogTab) are removed; `LogTab` returns to the original
  rail geometry. `Ctrl+B` tab cycling, `jk/f/d/Enter/F` keys and `F`
  (dump to the full-screen Pager) are unchanged — use `F` when you want
  a full-width log view.
- 1.4.0's session-picker, chrome and input fixes are untouched.

### Tests

- Dropped the 3 LogPanel cases from `test/tui-popup-width.test.mjs`
  (picker cases kept). Full suite: 1447 pass.

## [1.4.0] — 2026-11-24

TUI hardening release: the chrome stays one row tall at every terminal size,
multiline input can no longer eat the viewport, and the Ctrl+S session picker
is now full-width, column-aligned and height-safe like the Ctrl+P palette.

### Fixed

- **Header/footer pinned to exactly 2 rows at every resolution** —
  `BuildRail`/`StatusBar` carry `height={CHROME_HEIGHT}` + `overflow="hidden"`
  with a measured cell budget for the center region (the old `max(24,
  cols-34)` floor let brand/model names wrap and grow the bar). The brand
  degrades gracefully instead: `⚑ scoder` → `scoder` → `⚑`; status texts use
  `wrap="truncate"`, so the single content row always renders centered.
- **Multiline input no longer steals the sidebar/chat height** — `Input`
  windows its logical lines around the cursor (`windowInputLines`, exported)
  with a `maxRows` budget from the app (`min(8, rows/3)`); wrapped rows are
  counted, Shift+Enter lines beyond the window show `⋮ +N lines above/below`
  indicators, and the @-suggestion overlay is capped (5 rows). The sidebar's
  greedy-fit keeps its height while the input grows.

### Changed

- **Session picker (Ctrl+S) sizes from the terminal like the palette** —
  full-width frame and dividers (no more hard-coded 38-cell box), one-line
  column-aligned rows `▸ id · date · steps · task` on wide terminals with a
  two-line degrade when narrow, and a selection-following height window plus
  `⋯ +N more` indicator so the picker never overflows a 20-row terminal.

### Tests

- New `test/tui-popup-width.test.mjs` (full-width borders, column rows,
  height cap, narrow degrade); chrome fixed-height cases in
  `test/tui-render.test.mjs`; `windowInputLines` cases in
  `test/command-registry.test.mjs`. Full suite: 1447 pass.

## [1.3.0] — 2026-11-24

The model-router release: multi-provider config, per-turn model routing, and a
ROUTER tab in the TUI. Disabled by default — with no `router` block every code
path is byte-identical to 1.2.0.

### Added

- **Provider/models config block (P2.1, opencode-style)** — `"provider": {
  "<id>": { "npm": …, "options": { "baseURL": …, "apiKey": "{env:VAR}" },
  "models": { "<id>": { "name", "limit.context", "cost.input/output" } } } }`.
  Declared models register into the catalog (context window + pricing feed ctx
  %, compaction and cost), `provider/model` refs work everywhere (`-m`,
  `/model`, `router.tiers`), and inline keys are `{env:VAR}`-expandable with a
  warning when written literally.
- **Model router (P2.2)** — per-turn tier routing behind `"router": {
  "enabled", "tiers": { "small": […], "large": […] }, "fallback", "signals",
  "rules", "escalate", "judge" }`. Four decision layers (win order: pin >
  rules > judge > score > hysteresis): L1 scores the turn (ctx size, phase of
  the last tool call, tool-schema weight, plan/wrap-up), L2 `rules` force a
  tier via `phase|step|tokens|tools` expressions, L3 hysteresis escalates
  small→large after `buildFails` consecutive build failures, locks large until
  green and demotes only after 3 clean steps, L4 optional judge. `"model":
  "auto"` (rc / `-m auto` / `/model auto`) routes; any concrete model is
  PINNED — zero router overhead, zero `route_decision` events — and pin/auto
  toggle mid-session without restart. Bad tier refs warn + drop; routing can
  never fail a run (deterministic fallback). `src/router/*` +
  `RouterRuntime`, tests `router-*.test.mjs`.
- **L4 judge (`router.judge`, default `null` = 3-layer, ZERO extra requests)**
  — a cheap model names the exact target ref when L1 lands in the gray band
  (`scope: gray|first|always`). Strict JSON, TTL-10′ cache keyed on
  (context, tier, candidate refs), AbortController timeout, and it never
  throws: timeout/unparseable/error fall back to the L1+L2 decision with
  honest audited verdicts (`timeout` / `fallback` / `reject-hallucinated`).
  Judge calls bypass the agent loop, so they never pollute `llm_usage`,
  model stats or cost; their tokens are audited on `route_decision.judge`.
  `src/router/judge.ts`, `test/router-judge.test.mjs` (18 cases).
- **ROUTER sidebar tab** — `Ctrl+B` now cycles three tabs OVERVIEW → ROUTER →
  HARNESS LOG. The tab draws the live graph `user ─▶ router ─┬▶ ref …` (cap 4,
  `+N refs`), a packet dot runs along the active edge ~0.7 s per new decision
  (fully static under `SCODER_ANIM=0` / `SCODER_NO_MOTION=1` / `--no-motion`),
  plus folded DECISIONS (`⤳ tier ref — reason · ×N`) and MODELS stats
  (`calls in→out tok ~$cost`). SESSION badges the live model `[auto]`/`[pin]`,
  the tab bar shows a `⤳` badge while routing is armed, and the harness log
  gains a `ROUTE` filter slot.
- **`/router`** command — mode, tiers, last decision, judge layer.
- **`scoder cost --router`** — per-model cost breakdown + estimated savings vs
  running everything on the large tier; router eval gate
  (`test/eval/router-profile.mjs`, 4 configs) with baseline in
  `plan/baseline/router-eval.json`.

### Changed

- Session events (additive, schema stays v3): `route_decision` per routed
  turn; `llm_usage` carries `ref`/`tier` when routed; `run_start` carries
  `routingMode` + `tiers`.
- `--no-motion` / `SCODER_NO_MOTION=1` was documented but consumed by nothing;
  the route packet now honors it (alongside `SCODER_ANIM=0`).

### Verification

1432/1432 tests (+28 over 1.2.0), eval 13/13, typecheck clean, lint
0 errors / 43 warnings (= budget), layers + docs:check green, coverage gates
pass (92.4 lines / 85.5 branch / 92.8 funcs).

## [1.2.0] — 2026-11-23

Two user-facing changes: a `/btw` side-question channel, and every keybinding
written out in words instead of symbols across the TUI.

### Added

- **`/btw <question>` — side questions (REPL + TUI, pattern from Claude Code)**:
  one tool-less LLM call over a read-only snapshot of the current conversation.
  The question and answer never enter `this.messages`, so the main thread and
  its provider-side prompt cache stay untouched (the exchange costs barely more
  than the answer itself). Works while a task is running — an unfinished
  trailing tool-call round is trimmed from the snapshot, the live history is
  never touched. Side calls count toward `/cost`; a bare `/btw` replays the
  last answer. `Agent.sideQuestion()` + registry handler + docs
  (`test/btw.test.mjs`, `test/command-registry.test.mjs`).

### Changed

- **Keybindings are spelled out across the TUI** — `⌃T` / `⇧⇥` / `⏎` / `↑↓` became
  `Ctrl+T`, `Shift+Tab`, `Enter`, `Up/Down` in every surface a user reads: the
  `/shortcut` sheet, the `?` help panel, the bottom status bar, the panel footers
  (harness-log tab, DETAIL pane, full-screen viewer, palette, session picker, vim
  hint) and the `/agent`, `/permission`, `/help` texts. The status-bar hint line
  also stopped clipping mid-key: hints are now whole segments dropped from the
  tail when the terminal is narrow (`pickHints`), and the left side
  (status · model · git chip) reserves its width first, so the git chip survives
  at 100 cols. `src/tui/shortcuts.ts` + `chrome`/`app`/`sidebar`/`pager`/`palette`/
  `session-picker`/`input`/`permission-modal` (`.tsx`) and
  `src/commands/definitions.ts`; regression tests in `test/tui-shortcuts.test.mjs`
  and `test/tui-render.test.mjs`.

### Fixed

- **The `?` help panel tore the screen** — it was taller than the terminal (the
  command list alone is 23 rows), so Ink's diff paint spliced rows across the
  whole frame. The panel is now bounded by `maxHeight = rows - 8` with
  `overflow="hidden"`: the keys stay on top, the command list clips, and the
  subtitle points at `/shortcut` + `/help` for the full lists.
- **The git chip disappeared at 100 columns** — the status bar handed the hint
  line a fixed 0.72 budget no matter what the left side needed, so `⎇ main` got
  squeezed out entirely. The left side (status · model · git chip · queue
  badge) now reserves its width before the hints take the remainder
  (`test/tui.test.mjs`, P7).

## [1.1.0] — 2026-11-23

Full audit of the codebase (`fix/all-review-findings`, 11 commits) — every
P0/P1/P2 finding implemented with a regression test.

### Security

- **`web_fetch` SSRF closed at the socket level**: the guard used to resolve
  DNS, validate the answers, then hand the URL to `fetch()` — which resolves
  AGAIN (TOCTOU / DNS rebinding). web_fetch now resolves once, validates
  every answer, and PINS the connection to the audited IP (`lookup`
  override + `agent: false`, SNI/Host keep the original authority); every
  redirect hop re-validates + re-pins. Drive-by: the IPv6 link-local regex
  never matched `fe80::` — those addresses were treated as PUBLIC (live
  bypass, not just TOCTOU).
- **Sandbox fails CLOSED**: enabling `sandbox.mode` without its wrapper
  binary (`sandbox-exec`/`bwrap`) previously warned and executed the command
  COMPLETELY UNSANDBOXED. `run_command` now refuses with a tool error;
  `sandbox.strict: false` restores the old warn-and-run knowingly.
- **Project-config trust gate** (`config/trust.ts`): a cloned repo's
  `.scoderrc.json` sensitive fields (`baseUrl`, `apiKey`, `providers`,
  `mcpServers`, `buildCmd`, `verifyCmds`, `formatter`, `permission(s)`,
  `sandbox`, `shellEnvAllow`) and committed
  `.scoder/permissions.local.json` are DROPPED until the directory is
  trusted once via `scoder trust` / `SCODER_TRUST_PROJECT=1`. Kills the
  exfiltration + execution attacks of opening a hostile repo.
- **`scoder serve` hardened**: auth is mandatory (constant-time token
  compare, no unauthenticated mode), foreign `Host` (DNS rebinding) and
  cross-site `Origin`/`Referer` (browser CSRF) rejected, JSON endpoints
  require `application/json` (no CORS-simple POSTs).
- **Catastrophic-command detection rebuilt**: regex list over the raw string
  → structural analysis — quote-aware pipeline/sequence splitting, argv
  parsing, real questions ("is this `rm` recursive AND does an operand name
  a critical root or whole home?"). Obfuscations that slipped the regexes
  (`rm -rf $HOME`, `curl x | zsh`, `find / -delete`) are caught; a regex
  tail remains only for constructs argv cannot see (fork bombs, block-device
  redirects, `--no-preserve-root`). Fuzz suite included.
- **Request-boundary validation** (`validateRunRequest`): `POST /api/runs`
  no longer trusts `JSON.parse` shapes — null/array/scalar bodies and wrong
  field types get precise 400s instead of 500s or NaN riding into config.
- **Session-id entropy**: random suffix moved from `Math.random()` (16 bits
  in a same-second namespace → two launches could write ONE session dir) to
  `randomBytes(2)`; id format unchanged (name-sort == time-sort).

### Added

- **Escalating retry ladder** for transient LLM failures: 10s → 30s → 1m →
  3m → 5m → 10m (cap 15m when the server sends `Retry-After`), waits abort
  with the run signal; `baseDelayMs` opts back into classic exponential,
  `SCODER_RETRY_LADDER_MS` overrides the ladder (CI/tests).
- `scoder trust [path|--list|--revoke <path>]` subcommand +
  `SCODER_TRUST_PROJECT` escape hatch.
- `sandbox.strict` config field; OS-sandbox section in the configuration
  docs.
- **CI gates the repo now promises**: `docs:check` + `check-secrets` in the
  matrix, a macOS lane (Seatbelt enforcement tests actually run), a
  coverage lane (`scripts/check-coverage.mjs`, floors 88 lines / 78 branch /
  84 funcs), and `prepublishOnly` running lint + typecheck + FULL tests +
  eval.

### Fixed

- **Permission + provider state across `/model` hot-swaps** — swapped agents
  inherited stale permission checkers/provider runtimes.
- **UTF-8 streamed output**: multi-byte characters split across chunk
  boundaries decoded as one stream instead of producing replacement
  characters in tool output and the TUI.
- **Unnecessary line breaks while the agent generates** — the TUI renders
  the markdown pipeline DURING streaming (headings/bold/lists/code appear
  live with the ▋ cursor); the plain CLI normalizes newlines live (leading
  blanks dropped, 3+ collapses to one paragraph break, `\r` stripped).
- **Subagent output budget**: a child's summary is clamped to the parent's
  `limits.maxOutputChars` with an explicit truncation marker — one chatty
  explore run can no longer eat the parent's context.
- **In-flight run guard**: `run()/runTurn()/resume()` on a busy Agent reset
  the active run's signals and double-wrote the event log; overlap is now
  refused at the entry, release owned by the run loop.
- **Flaky test timers**: SIGKILL-vs-`exit`-event race in mcp-reconnect
  (plus orphaned mock servers hanging the file), debounce-window strictness
  in hot-reload, fixed ink-paint wait in tui-render — all deadline/poll
  based now.

### Changed

- `agent.ts` decomposition continues: the task-tool subagent runner (spawn,
  event relay, abort cascade, summary clamp) moved to
  `agent/subagent-runner.ts` (runtime-injected, no import cycle).
- Docs drift corrected: MCP tools are permission-checked by NAME (the old
  "bypass the permission system" claim was false since `classifyMcpTool`),
  readonly profile semantics, test-suite tables extended with the new
  suites, `docs/testing.md` CI section rewritten.
- Dev dependencies: eslint 10.15, typescript-eslint 8.73, `minimatch ^11`
  override — `npm audit` 9 moderate ReDoS findings → 0 vulnerabilities.
- `npm run lint` pinned to `--max-warnings=43`: a warning-budget ratchet —
  the tracked long tail cannot grow unnoticed.

## [1.0.0] — 2026-11-22

### Added
- **`/shortcut`** — every keybinding of the TUI in one place, shown in the
  full-screen viewer (grouped GLOBAL · SCROLLING · INPUT · HARNESS LOG ·
  VIEWER · PALETTE · SESSION PICKER). Aliases `/shortcuts`, `/keys`; the
  cheat sheet lives in `tui/shortcuts.ts` and is unit-tested so it stays in
  sync with the real handlers. The `?` overlay only carries headline keys.
- **TUI command palette (`Ctrl+P`)** — fuzzy-searchable, grouped actions
  (builtin + custom commands, agents, themes, permission modes, session
  picker) replacing the static key/value dump; Enter dispatches through the
  command registry like a typed command (plan/TUI-UX-UPGRADE-PLAN.md P2).
- **TUI full-screen viewer (`v`)** — page through the newest 30 tool outputs
  and diffs with vim-style keys, wheel, and `Tab` cycling; diffs render
  word-level highlighting (git `--word-diff` style pre-pass); `y` saves the
  full text to `.scoder/views/` (P3).
- **Scroll affordances** — `▼ +N new lines` pill while scrolled up during a
  run, plus a 1-column proportional scrollbar on the chat pane edge (P4).
- **Multi-language code highlighting** — fenced blocks in the transcript are
  tokenized per language from a small rules table (`js/ts/tsx`, `python`,
  `go`, `rust`, `java`, `c/cpp`, `sql`, `bash/sh`, `json`, `yaml`, `toml` +
  aliases); unknown languages keep the JS rules. No native parsers, no hot
  path cost — same stance as `repo-map.ts` (P5).
- Status bar shows the steering-queue badge (`⇢ N`) and, when the sidebar is
  hidden on narrow terminals, compact `ctx % · $cost` metrics (P1).
- **Tabbed sidebar + Harness Log (`Ctrl+B`)** — the sidebar now has two tabs:
  OVERVIEW (unchanged sections) and HARNESS LOG, a live 800-row ring of every
  harness activity (llm/tool/shell/file/build/mcp/subagent/guardrail/permission/
  context). Streaming events merge into one row with chunk/byte counters; `↑↓`
  select, `f` filter, `d` detail, `⏎` opens the full payload in the viewer
  (transcript item → `.scoder/logs/<session>.jsonl` fallback), `y` copies,
  `/log [cat]` dumps the log for narrow terminals (P8).
- **Harness Log audit columns** — every row now carries a fixed text kind
  label (`RUN LLM TOOL SHELL FILE BUILD MCP SUB GUARD PERM EVT`) instead of a
  bare glyph, a compact `HH:MM:SS` clock (the tenths digit was eating 3 cells
  of body), and outcome-colored labels; repeating events (context pressure,
  queue depth, todo flips, warmup ticks, history trims) fold into one live row
  with a `· ×N` counter so the audit trail is complete without flooding —
  nothing is silently dropped anymore. `F` on the LOG tab dumps the whole
  filtered log into the full-screen viewer (wide rows, no truncation); the
  `SYS` filter bucket is renamed `EVT` (P8 follow-up).
- **Desktop notification on finish** — when a run ends (success/failed) while
  the terminal is unfocused, scoder emits an OSC 777 notify with status, step
  count, duration and a sanitized summary. Focus tracking uses DEC 1004; on
  terminals that never report it the fallback is "run longer than 45 s".
  Opt out with `SCODER_NOTIFY=0` or rc `"notify": false` (P6).
- **Git context in the Build Rail** — `⎇ <branch> · ±N` (branch + dirty entry
  count) while idle; while running or when a guardrail holds the rail center
  the chip moves to the Status Bar left. Probed asynchronously
  (`workspace/git-status.ts` parses `git status --porcelain -b`, renames and
  unmerged paths counted once) with a 5 s idle cadence plus a refresh on
  finish; hidden outside a repo, on probe failure, or when the budget is gone
  — never a blocking call on the render path (P7).

### Changed
- The sidebar's first row is now the OVERVIEW/HARNESS LOG tab bar — section
  content is unchanged, one row of the height budget goes to tabs (P8).
- **Sidebar tab bar now has a one-row gap beneath it** — the OVERVIEW/HARNESS
  LOG tabs are visually separated from the section content below (the terminal
  equivalent of the requested ~12px margin-bottom). The row is reserved in the
  height budget, so the greedy-fit sections shift down by one row (a plan that
  capped at one line on a 32-row terminal now needs 33).
- Tool transcript rows carry an explicit `✓`/`✗` status glyph once finished
  (previously color-only) (P1).
- Overlay keyboard ownership unified: palette, session picker, help and the
  viewer each own the keyboard while open — keys no longer leak into the
  input field (P2/P3).
- Interface microcopy consolidated to English across welcome, hints and
  notices (P1).

### Fixed
- **Duplicate user command in the transcript** — submitting a task pushes the
  `you ▸ …` line immediately; when a `notice` landed between that push and the
  `run_start` event (e.g. pressing `⏎` on the empty Harness Log tab → "no log
  row selected"), the reducer's last-item dedupe missed it and printed the same
  command a second time. The dedupe now scans back past trailing notices.
- **Scroll-to-bottom no longer leaves the last line floating mid-screen** —
  the scroll offset counts ESTIMATED rows; on wide terminals the estimate
  over-counts (paragraphs wrap wider than the 60/76/EST_WIDTH assumptions),
  so the estimated bottom sits past the real one: scrolling up during a run
  and back down showed the generated tail with blank below, a stuck
  `▼ +N new lines` pill and a scrollbar thumb that refused to reach the end.
  When the mounted window reaches the last item, `contentOffset` is now
  clamped to the window's measured bottom (tail anchor in
  `tui/scrollbar.ts`), and pill/thumb/status treat the view as at-bottom.

## [0.9.20] — 2026-11-19

### Changed
- **Subagents are step-unlimited** — the task tool no longer caps child runs at
  `min(parent maxSteps, 20)`; a subagent ends on completion, guardrail stop, or
  parent abort. Agent defs that declare `steps:` keep their explicit budget.
  CLI step counter and startup banner render the unlimited budget as `∞`.

## [0.9.19] — 2026-11-18

### Performance
- **Round-2 deep perf pass — 25 verified hot-path issues fixed with behavior
  held byte-identical** (tool outputs, error strings, redaction results and
  the permission decision matrix unchanged; 1024 tests + e2e + MCP smoke
  green):
  - `estimateTokens` is an incremental prefix sum keyed on array identity —
    the per-step full re-encode of the joined history (2–3 encodes/step,
    quadratic over a run) becomes O(new messages); tool-schema text and
    sizes memoized per array (`src/context/compaction.ts`, `src/llm/prompt-metrics.ts`)
  - snapshot + manifest rewrites throttled to ≥5 s at the persist layer
    with a forced write on every terminal path; `compaction.ran` carries the
    replacement history so the event-log projection and `scoder resume` stop
    re-growing trimmed messages (`src/agent/session-persistence.ts`, `src/session/session.ts`)
  - Anthropic streams share the single idle watchdog (no per-chunk
    AbortController/timer/race) and one WeakMap `parseToolArgsCached` replaces
    7 JSON.parse sites — the provider serializer no longer re-parses whole
    files from history every request (`src/llm/tool-args.ts`, `src/llm/provider-anthropic.ts`)
  - `read_file` probes images via a 16-byte fd window (was a full binary
    slurp + second utf8 read); `list_files` never dereferences symlinks (was
    a realpath chain per entry); `edit_file` got the 2MB size gate; line
    counting and edit matching switched to indexOf scans — no whole-file
    split arrays (`src/tools/*`)
  - shell decisions memoized on (mode, rules, policy, allowlist version);
    the redaction pre-gate is one alternation regex (no `toLowerCase` copy
    per 500 KB log); MCP `structuredContent` skips the stringify round-trip
    when clean; reconnect backoff is cancelable (`src/security/permissions.ts`, `src/llm/llm.ts`, `src/mcp/connection.ts`)
  - workspace fingerprint runs async (`verifyAll` froze the event loop
    50–500 ms in `spawnSync rg` + 5 000 statSync); file-index invalidation
    marks stale + scoped (no sync rg rebuild on the next `@` keystroke); the
    snapshot git probe left the constructor (lazy, async on capture); sandbox
    wrapper presence probed once per process (`src/workspace/*`, `src/security/sandbox.ts`)
  - rc-derived permission lists, policy/approval files, custom commands,
    skills and the repo map cache behind (mtime, size) signatures — the
    per-prompt-build re-parse/re-scan happens once per actual change;
    duplicate skill warnings are deduped instead of appended forever
    (`src/config/config.ts`, `src/commands/definitions.ts`, `src/context/skills.ts`, `src/context/repo-map.ts`)
  - TUI: tool-output previews tail-scan (no 200 KB log split per frame),
    streaming wrap estimates measure only the appended delta, highlight and
    table-column math cached per line/rows identity, mermaid slug+write once
    per source (`src/tui/*`)

### Fixed
- **Subagents no longer freeze mid-run** — the task relay dropped the child's
  `permission_request` event while the child's broker waited for an answer
  that could never arrive: any subagent action needing approval stalled the
  full 60–120s timeout with no modal shown (batch mode: up to 4 children
  frozen at once). `permission_request` now streams to the parent's UI sink
  tagged `<childId>:perm-N` and `Agent.resolvePermission()` routes the answer
  back to the child's broker (TUI needs no changes) (`src/agent.ts`)
- **Subagent progress is visible in the chat transcript** — relayed child
  activity was emitted as `tool_output` under a `subagent:<name>` tool name,
  which the TUI reducer could not correlate to the running `task` card, so
  the card streamed nothing for the whole sub-run. Chunks now attach to the
  `task` card, with `→ <agent>: <tool>` marker lines (`src/agent.ts`,
  `test/eval/subagent-task.mjs`)
- **Spawnable-subagent filter corrected** — the advertised task list used
  `mode !== "subagent" || name === "explore"`, hiding user-defined
  `mode: subagent` agents (the mode's documented purpose) while advertising
  primary-only ones. Shared `subagentDefs()` predicate (mode `subagent|all`,
  non-hidden) is now used by the prompt block, the error hint and the TUI
  completion, and the task tool refuses to spawn non-subagent defs
  (`src/context/agents.ts`, `src/context/prompt-builder.ts`, `src/agent.ts`)
- **`task` tool is no longer advertised to depth-1 children** (and any agent
  with `allowSubagents: false`) — doomed calls burned a step on "tool not
  wired"; the error now reads as the depth limit it is
  (`src/tools/registry.ts`, `src/tools/task-tool.ts`)
- **No more `⚠ agent "explore" is a subagent` warning spam** every time the
  task tool spawned a child — the warning targets user selections (which the
  CLI/TUI already block), children now pass `programmaticSubagent`
  (`src/agent/types.ts`, `src/config/config.ts`)
- **Abort-listener leak per spawn** removed (listener + child references are
  released in `finally`); a throwing batch task no longer discards its
  siblings' results (`src/agent.ts`)

## [0.9.18] — 2026-11-16

### Fixed
- **TUI: chat-only replies no longer duplicated as a raw green block** — the
  `✔ <summary>` line rendered after the transcript reprinted the assistant's
  full reply (guardrails `chat-done` / `text-only-streak` / `completion-claim`
  set the finish summary to the reply text, sliced to 2000 chars). The reply
  is already rendered as markdown above, so the raw-markdown echo read as a
  duplicate-output bug (it vanished on the next question because `run_start`
  resets the summary). The summary is display-only — it never entered the LLM
  context, and it still lands in events and the session manifest; the dedup
  happens at render time in `src/tui/app.tsx`

## [0.9.17] — 2026-11-16

### Added
- **Theme in the config file** — `"theme": "solarized"` in `.scoderrc.json` /
  `~/.scoder/config.json` (plus a `--theme <name>` CLI flag) now sets the TUI
  palette; precedence `.scoder/theme.json` > `SCODER_THEME` env > config
  `theme` > terminal-capability autodetect. `/theme` stays a session-only
  hot-swap (`src/config/config.ts`, `src/tui/theme.tsx`)
- **`Shift+Enter` inserts a newline** in the TUI input (multi-line messages;
  `Enter` still sends) — via the kitty keyboard protocol, negotiated at
  startup with `render({ kittyKeyboard: { mode: "auto" } })`, with universal
  fallbacks `Alt+Enter` / `Ctrl+J` / bare `\n` (iTerm2-style). Continuation
  lines render indented under the `❯` prompt (`src/tui/input.tsx`)
- **`Shift+Tab` cycles the primary agent** build→plan→review in the TUI —
  dispatches `/agent` through the shared registry, so it inherits its gates
  (blocked while running, conversation reset on switch; custom agents stay
  on `/agent <name>`)
- **`Shift+P` cycles the permission mode** auto→ask→readonly (dispatches
  `/permission`, applies live) — fires only when the input is empty, the
  same convention as `?` for help, so a capital `P` can still be typed
  mid-message
- Status-bar keybind hints and the `?` help overlay document the three new
  keys

### Tests
- `test/tui.test.mjs` — PTY integration: `\x1b[Z` (⇧Tab) → `agent → plan`
  notice, `P` → `permission mode → ask` notice, kitty `\x1b[13;2u`
  (⇧Enter) renders two input lines without submitting
- `test/command-registry.test.mjs` — `nextInCycle` (agent/permission cycles,
  unknown/custom value wraps to the first entry) + `isNewlineKey`
- `test/config.test.mjs` / `test/theme.test.mjs` — `theme` precedence
  (rc/env/flag), config theme in `defaultThemeName`/`getTheme`,
  `THEME_NAMES` ↔ `THEMES` sync

## [0.9.15] — 2026-11-15

### Added
- **Mermaid flowcharts now render as real graphs in the TUI** (P9,
  `src/tui/markdown/graph.ts`) — a pure, Ink-free layout engine: parse
  (shapes, `-->`/`-.->`/`==>`, inline & split-arrow labels, chains,
  subgraphs, comments) → longest-path ranking with DFS cycle-breaking →
  barycenter ordering → box placement → cell-grid rasterization, colored per
  cell kind (borders, labels, edges, arrowheads). Two placement modes:
  `layered` bands for branching graphs and `strip` rows (wrapped chain with
  `──▶` connectors) for long timelines; label caps shrink until the graph
  fits, and anything that still cannot fit degrades to the previous
  structured summary box — never a clipped drawing. `BT`/`RL` reverse edges
  and move arrowheads upstream; cycle-closing edges and dropped labels are
  reported as notes.
- `charset.ts`: graph glyph set — a 16-entry connection-mask line table
  (every elbow/tee/cross falls out of the mask), heavy/dotted strokes,
  directional arrows, per-shape corner styles, loop marker — all with ASCII
  fallbacks (`SCODER_ASCII=1` / `TERM=dumb`).
- Diagram sources are saved deterministically to
  `.scoder/diagrams/<slug>-<sha6>.mmd` (gitignored), so the export hint is a
  command that actually runs instead of a `-i <file>` placeholder.
- `estimateMarkdownRows` uses the real raster height for drawn graphs
  (virtualization window matches what is rendered).

### Fixed
- `<br/>` (and other HTML/entities like `&amp;`) inside mermaid node labels
  showed literally; `cleanMermaidLabel` now converts breaks to spaces,
  decodes entities and strips tags for both the drawn graph and the summary
  box.
- The charset corner table had indices 3↔9 and 7↔13 swapped, mirroring
  elbows (`╯`/`╰`, `├`/`┤`) in drawn connectors; fixed.

### Testing & docs
- New `test/graph-layout.test.mjs`: parsing/label cleanup, fit across widths
  24–120, the no-row-overflows-the-pane invariant, a deterministic
  garbage-graph fuzz pass, cache determinism, and an ASCII-mode child-process
  spec. New snapshot fixtures `mermaid-br` / `mermaid-chain` /
  `mermaid-branch`; mermaid snapshots regenerated at 40/80/120.
- Docs: `src/tui/README.md` pipeline notes, `plan/TUI-UPGRADE-PLAN.md` P9
  section, and the system prompt now tell the agent that flowcharts render
  natively (≤ ~12 nodes recommended). 1000/1000 tests green.

## [0.9.14] — 2026-11-14

### Fixed
- **Permission `ask` timeout timer leak** in `PermissionChecker.ask` and `InteractionRuntime.awaitQuestion` — `setTimeout` was not cleared when the handler resolved first, keeping the event loop (and tests/process) alive up to `timeoutSecs`. Timers are now cleared in `finally`.
- **Shell permission bypass via command substitution**: `echo $(rm -rf /)` could pass an allow-prefix rule. Scanner-detected `$()`/backticks now require `ask` unless an explicit rule allows the whole line.
- **`runTurn` did not reset per-run state** (`runDiffs`, `selfReviewDone`, `verifyStrikes`, `lastVerifySignature`) → self-review/verify strikes could stay stale across chat turns. Also reset `measuredFixedTokens` on run tool rebuild.
- **File index cache was a single global slot** regardless of workdir → wrong file lists in multi-workdir/server setups. Now keyed by workdir.
- **Unhandled promise rejections** in a few fire-and-forget `void ...` calls (MCP hot-reload, warmup, refresh) — added `.catch`.

### Performance / robustness
- Small robustness fixes from deep audit; no breaking API changes.

## [0.9.13] — 2026-11-14

### Testing & CI
- **PTY TUI specs now pass on GitHub Actions — root-caused after failing
  since the day they were added.** Ink 8 gates interactivity with `is-in-ci`:
  any `CI`/`CONTINUOUS_INTEGRATION` env makes `render()` non-interactive
  *even on a real TTY*, so frames were never written — the PTY capture stayed
  blank (`raw=16B`), the TUI waited forever for its own render, and
  `pty-run.py` hit its 60 s timeout (exit 124). The new failure context
  added in 0.9.12 produced the proof, and `CI=true node --test
  test/tui.test.mjs` now reproduces/verifies the fix locally. The harness
  strips CI from the PTY child's env: the spec simulates a real user
  terminal, where CI semantics don't apply. Product behavior unchanged.

## [0.9.12] — 2026-11-14

### Fixed
- **`run_command` abort/timeout now reaps the whole process tree — fixes the
  `scoder serve` abort test failing on Linux CI since 0.9.9** — `spawn` ran
  the shell in the parent's process group, so SIGTERM reached only the
  `sh -c` wrapper; on Linux the grandchild (`sleep`, `make`, `npm …`)
  survived, kept the stdio pipes open and the tool result waited for a
  `close` that only came after the grandchild's own timeout — the run never
  emitted `finish`. Children now get their own group (`detached`) and are
  killed via `kill(-pid, SIGTERM→SIGKILL)`; when killed, the promise
  resolves on `exit` without waiting for pipe EOF. macOS never hit it because
  bash execs single commands; reproduced deterministically in an
  ubuntu-equivalent container.
- **`grep` fallback honors `include` and skips noise dirs — fixes the two
  `toolGrep` CI cases** — GitHub runners ship no `rg`, so `toolGrep` took the
  portable `grep -rn` path, which ignored the `include` filter and searched
  `node_modules`. GNU `--exclude-dir=…` / `--include …` added (mirrors the
  rg fast path); a grep that rejects the flags exits ≥2 and falls through to
  the JS scanner, which was already correct.

### Testing & CI
- `test/eval/text-only-streak.mjs` asserted the pre-P0-8 loop (text-only
  steps get nudged until the streak fires). P0-8 makes a tool-less step with
  no file changes and no open plan a *chat turn* that finishes after one LLM
  call, so the streak could never reach its limit — the eval gate (10/11)
  failed on every CI attempt since it was added. Rewritten to stall WITH an
  open plan (the guardrail's real domain) and a new `test/eval/chat-turn.mjs`
  pins the one-call chat semantics (12/12).
- `test/theme.test.mjs` pins the terminal-capability env (`TERM`,
  `NO_COLOR`, …) in `beforeEach`/`afterEach` — the runner leaves `TERM`
  unset, which makes the caps default theme `mono` and turned every
  mission/`'magenta'` assertion into `'white' !== 'magenta'`.
- `test/tui.test.mjs` PTY specs: `pty-run.py`'s stderr is captured into the
  failure context (raw bytes + exit code were previously thrown away),
  the PTY budget doubled to 60 s and the two specs serialized
  (`concurrency: 1`) against cold-`npm ci` runner starvation.
- `ci.yml`: `fail-fast: false` — one node version's failure no longer
  cancels the other jobs' evidence (run 43568456376 showed node 20/24 as
  "cancelled" while they were failing the same tests).

## [0.9.11] — 2026-11-14

### Features
- **TUI select mode (`Ctrl+O`)** — toggles off SGR mouse tracking so the
  terminal's native drag-highlight + copy (`⌘C`/`Ctrl+C`) works on transcript
  text; wheel scroll pauses (PgUp/PgDn still scroll) and the status bar shows
  the copy reminder while the mode is on.

### Performance
- **File reads cost 1–2 LLM turns instead of ~6 (FILE-READ-PERF P1+P2)** —
  measurement from `.scoder/logs`: the `read_file` tool itself is 1 ms, but a
  28 KB README took 6 sequential turns × 8–11 s because the local profile
  pinned `limits.toolOutputChars` at 6000. The budget is now derived from the
  *probed* context window (`clamp(0.17 × window, 6000, 16000)` chars — 16k at
  96k slots, unchanged 6000 at small windows; explicit rc values always win),
  the truncation footer and the V6 prompt tell the model to issue ALL
  remaining `read_file(offset=…)` slices in ONE step (read-only calls already
  run concurrently up to `toolConcurrency`). Logged as `{"type":"read_budget"}`.
- **Idle heartbeat re-warm on local engines (FILE-READ-PERF P3)** — cache/
  `keep_alive` TTLs (~5 min) made the first message after a pause pay 35–56 s
  cold prefill (measured TTFT 54.3 s at 14.5k tokens). An armed interactive
  REPL/TUI session with a loopback `baseUrl` now re-sends the warm-up request
  every 4 min while idle — replaying the real history once turns exist — so
  the model stays loaded and the KV-cache fresh. Never for cloud APIs (no
  paid cache-holding), `serve`/run-once, or during a run; timer is `unref()`
  and cancelled by `dispose()`. Opt out with `"warmup": false`. Details:
  `plan/FILE-READ-PERF-PLAN.md`; tests: `test/warmup.test.mjs`, `test/limits.test.mjs`.
- **First-message cold prefill moved to session start (WARMUP)** — REPL and
  TUI now send one background `max_tokens: 1` request as soon as the agent is
  created, carrying the exact system+tools prefix the first real call will
  use. Model cold-load, MCP server spawn and context-window probe leave the
  path to the first token; local engines get their KV-cache filled and
  Anthropic gets the I-04 cache write while the user is still typing. A real
  run supersedes an in-flight warm request (abort + settle, no double MCP
  spawn). Opt out per project with `"warmup": false` (`.scoderrc.json`);
  `scoder <task>` and `scoder serve` never warm up. Details:
  `plan/WARMUP-PLAN.md`; tests: `test/warmup.test.mjs`.

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
