# mcp/ — Model Context Protocol

**Responsibility:** stdio/HTTP/SSE transports, connection lifecycle
(`manager.ts`), env interpolation, config import (`mcp-import.ts`), types.

**Public API:** via `../mcp.ts` facade (`McpManager`, `McpServerConfig`, …).

**Anti-patterns:** spawning per-call (connections are session-scoped);
swallowing transport errors silently (audit log via reporter).
