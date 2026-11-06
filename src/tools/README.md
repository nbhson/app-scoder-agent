# tools/ — tool implementations

**Responsibility:** the agent's tool set — file ops, shell, search, patch,
webfetch, registry (`registry.ts` defines order + specs).

**Public API:** direct imports (`./registry.js`, `./types.js`, …).

**Anti-patterns:** changing tool names/schemas/order (public contract);
importing `tui/`.
