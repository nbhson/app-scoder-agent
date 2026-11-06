# commands/ — slash commands

**Responsibility:** command metadata + parsing (`definitions.ts`), dispatch
against a `CommandHost` (`registry.ts`), transcript export/search
(`transcript.ts`), UI-independent transcript contract (`types.ts`).

**Public API:** used by `cli/repl.ts` and `tui/`; legacy facades exist at
`tui/commands.ts`, `tui/command-registry.ts`, `tui/transcript.ts`.

**Allowed imports:** core domains; never `tui/` (use `types.ts` for the
transcript shape).

**Anti-patterns:** adding UI framework imports; diverging command behavior
between REPL and TUI (both go through `dispatchCommand`).
