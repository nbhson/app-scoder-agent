# io/ — output port

**Responsibility:** `Reporter` port (`reporter.ts`) that core uses instead of
stdout; terminal adapter (`terminal.ts` — legacy `ui.ts`); console reporter
(`console-reporter.ts`).

**Allowed imports:** nothing from core domains (leaf).

**Anti-patterns:** importing `terminal.ts` from core — core depends only on the
`Reporter` interface.
