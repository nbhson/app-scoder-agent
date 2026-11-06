# tools/ — tool implementations

**Responsibility:** the agent's tool set — file ops, shell, search, patch,
webfetch, registry (`registry.ts` defines order + specs).

**Public API:** via `../tools.ts` facade (`allToolSpecs`, executors, types).

**Anti-patterns:** changing tool names/schemas/order (public contract);
importing `tui/`.
