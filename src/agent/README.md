# agent/ — Agent subsystems

**Responsibility:** the autonomous coding agent — event-typed run loop, tool
execution, MCP bridge, permission interaction, prompt context, session
persistence, verification, guardrails.

**Public API:** via the `../agent.ts` facade (`Agent`, `EVENT_SCHEMA_VERSION`,
`resolvePrimaryConfig`). Do not deep-import into `agent/*` from outside without
adding it to the facade's export surface.

**Allowed imports:** all core domains; never `tui/`.

**Anti-patterns:** writing to stdout directly (use the Reporter port via
`io/reporter.js`); reordering event emission in `run-loop.ts` (event order is a
public contract).
