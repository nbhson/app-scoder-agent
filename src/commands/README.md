# commands/ — slash commands

**Responsibility:** command metadata + parsing (`definitions.ts`), dispatch
against a `CommandHost` (`registry.ts`).

**Public API:** used by `cli/repl.ts` and `tui/` (import from here directly —
no facades).

**Allowed imports:** core domains; never `tui/`.

**Anti-patterns:** adding UI framework imports; diverging command behavior
between REPL and TUI (both go through `dispatchCommand`).
