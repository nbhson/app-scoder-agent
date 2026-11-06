# server/ — HTTP/SSE delivery

**Responsibility:** `scoder serve` — POST tasks, stream AgentEvents over SSE.

**Public API:** `startServer` — import from `./server.js`.

**Anti-patterns:** consuming agent events differently from the TUI (same
stream, same order).
