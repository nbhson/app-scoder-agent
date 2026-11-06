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
row, cell wrap, key-value fallback for narrow panes, 50-row cap) and
`markdown/diagram.tsx` (mermaid structured summary, ```chart / ```timeline
fences). Inline tokens: `markdown/inline.ts` (parse) + `inline-render.tsx`
(Ink). Parse results are LRU-cached per text; `ChatItemView` is memoized with
field-level equality (state mutates items in place — reference equality would
freeze streaming).

## Layout & charset invariants

- `text-width.ts` (`measure/clipCells/padEndCells/padStartCells/wrapCells`) is
  the ONLY way to measure/clip/pad/wrap visible text — cell-accurate for
  emoji, CJK, combining marks (Vietnamese), ANSI passthrough.
- `charset.ts` holds every drawing glyph (box chars, blocks, spinner, markers)
  with an ASCII fallback (`SCODER_ASCII=1` or `TERM=dumb`).
- Colors: Ink/chalk already respect `NO_COLOR`/`FORCE_COLOR` — never hardcode
  ANSI codes.
- Render fixtures: `test/fixtures/markdown/*.md`; eyeball via
  `node scripts/render-md.mjs <fixture> [width]`; snapshots in
  `test/snapshots/markdown/` (regenerate with `UPDATE_SNAPSHOTS=1`, review the
  diff before committing).
