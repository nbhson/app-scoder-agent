# cli/ — command-line interface

**Responsibility:** argv parsing (`args.ts`), one-shot mode (`run-once.ts`),
classic REPL (`repl.ts`), first-run wizard (`init.ts`), `mcp` subcommand
(`mcp-command.ts`), composition root (`main.ts`).

**Entry:** `../index.ts` facade (shebang + entry guard + re-exports
`parseArgs`/`runInit` for tests).

**Allowed imports:** core domains + `commands/`; never `tui/`.

**Anti-patterns:** changing help text/flag semantics (CLI contract is public).
