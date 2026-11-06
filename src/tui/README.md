# tui/ — Ink terminal UI

**Responsibility:** full-screen TUI. `app.tsx` is composition + layout only;
logic lives in `hooks/` (event queue, submit, keybinds, scroll,
command host, session resume); pure event→state reducer in `state.ts` +
`selectors.ts`; components: `chat-views`, `chrome`, `input`, `sidebar`, …

**Allowed imports:** anything (frontend layer).

**Anti-patterns:** putting business logic in components; changing render
order/keys/ANSI output.
