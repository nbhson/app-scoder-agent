# server/ — HTTP/SSE delivery

**Responsibility:** `scoder serve` — POST tasks, stream AgentEvents over SSE.

**Public API:** `startServer` — import from `./server.js`. Every request must
send `Authorization: Bearer <token>` (`SCODER_SERVER_TOKEN`, or a generated
token printed at startup — see `docs/api.md`); foreign `Host`/`Origin` and
non-JSON POST bodies are rejected.

**Anti-patterns:** consuming agent events differently from the TUI (same
stream, same order).
