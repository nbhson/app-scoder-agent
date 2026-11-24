# tui/ — Ink terminal UI

**Responsibility:** full-screen TUI. `app.tsx` is composition + layout only;
logic lives in `hooks/` (event queue, submit, keybinds, scroll,
command host, session resume); pure event→state reducer in `state.ts` +
`selectors.ts`; components: `chat-views`, `chrome`, `input`, `sidebar`, …

**Allowed imports:** anything (frontend layer).

**Anti-patterns:** putting business logic in components; changing render
order/keys/ANSI output; measuring/clipping display strings with
`String.length`/`padEnd`/`slice` — always use `text-width.ts`.

## Markdown pipeline (assistant messages)

`markdown.tsx` (orchestrator, stable public surface) → `markdown/parse.ts`
(pure text → Block AST, `ast.ts`) → `markdown/render.tsx` (AST → Ink) with
dedicated renderers: `markdown/table.tsx` (GFM tables: full borders, alignment
row, cell wrap, key-value fallback for narrow panes, 50-row cap),
`markdown/graph.ts` + `markdown/diagram.tsx` (mermaid **flowcharts are drawn
for real**: parse → longest-path ranking → barycenter ordering → box/edge
rasterization into a cell grid; `layered` mode for branching graphs (the
routing band tightens 3→2→1 rows before the graph gives up height), `strip`
mode (wrapped rows of boxes) ONLY for chain-shaped graphs — a branching
graph in strip would lose most of its edges, so it degrades to a structured
summary box instead; sequence/other diagram types stay summary/source; every
FINISHED preview saves its `.mmd` under `.scoder/diagrams/` so the export
hint is runnable (a still-open fence is never exported — its partial source
would litter the folder every repaint), plus ```chart / ```timeline fences. Inline
tokens: `markdown/inline.ts` (parse) + `inline-render.tsx` (Ink). Parse
results are LRU-cached per text; `ChatItemView` is memoized with field-level
equality — `state.ts` therefore updates chat items IMMUTABLY (`patchItem`
replaces the object); in-place mutation would make prev/next props the same
object and freeze streaming/tool updates.

**Diagram focus (P2.3)** — pointing at one node without re-printing the whole
graph. Two channels: in-source (`%% focus: <id>` directive or the `:::focus`
class) and live through the `diagram_focus` tool, whose `tool_call` event lands
in `state.diagramFocus` and reaches memoized blocks via `DiagramFocusContext`
(props of `ChatItemView` stay stable). Either way the node's box and label flip
to the accent color and a packet (`◆`) rides its edges for one short burst —
the same hook the ROUTER tab uses (`hooks/use-pulse.ts`, 6 frames ≈0.7s;
`SCODER_ANIM=0` / `SCODER_NO_MOTION=1` stay fully static). While a graph is
focused, edge routing claims lanes (strict → shared-label → loose): the
focused node's edges share one visible label (`*`) so they draw as a single
pipe the packet can follow; unfocused graphs take exactly the classic ladder
and render byte-identical to before. The overlay is two pure helpers in
`graph.ts` — `pulseMarks` (which cell this frame) + `paintCells` (grid-exact
paint that never changes a row's measured width, CJK-safe; the wide-glyph
spacers they expose also fixed a pre-existing off-by-one that leaked extra
spaces around double-width box labels). ```chart fences accept a `focus`
(alias `active`) label that swaps one row's bar marker for `◆`.

## Layout & charset invariants

- `sidebar.tsx` renders under a real height budget (`rows` measured from the
  main row): sections greedy-fit in the fixed display order SESSION → MCP →
  METRICS → PHASES → PLAN → SUBAGENTS → BUILD; a section that doesn't fit
  wholly is SKIPPED (never half-clipped); PLAN shrinks to the remaining space
  ("… +N more"). PLAN reads `state.plan` — a dedicated field (not the chat
  items) so it survives `MAX_ITEMS` eviction on heavy runs.
- `text-width.ts` (`measure/clipCells/padEndCells/padStartCells/wrapCells`) is
  the ONLY way to measure/clip/pad/wrap visible text — cell-accurate for
  emoji, CJK, combining marks (Vietnamese), ANSI passthrough.
- `charset.ts` holds every drawing glyph (box chars, blocks, spinner, markers,
  and the flowchart set: connection-mask line table, heavy/dotted strokes,
  arrowheads, node corners) with an ASCII fallback (`SCODER_ASCII=1` or
  `TERM=dumb`).
- Colors: Ink/chalk already respect `NO_COLOR`/`FORCE_COLOR` — never hardcode
  ANSI codes.
- Render fixtures: `test/fixtures/markdown/*.md`; eyeball via
  `node scripts/render-md.mjs <fixture> [width]`; snapshots in
  `test/snapshots/markdown/` (regenerate with `UPDATE_SNAPSHOTS=1`, review the
  diff before committing).
