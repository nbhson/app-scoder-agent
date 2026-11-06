# security/ — permissions & sandbox

**Responsibility:** permission modes (`permissions.ts`: auto/ask/readonly,
allow/deny lists, catastrophic-deny floor), shell scanner (`shell-scanner.ts`),
sandbox helpers (`sandbox.ts`).

**Anti-patterns:** weakening a deny to ask; changing permission semantics —
they are a public contract.
