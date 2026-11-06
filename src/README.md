# Source map

Domain-oriented layout. The root holds only the CLI entry (`index.ts`) and the
Agent facade (`agent.ts`) — all other implementation lives in domain folders.

## Domains

| Folder | Responsibility |
|---|---|
| `cli/` | CLI parsing + subcommands (`args`, `run-once`, `repl`, `init`, `mcp-command`, `main`) |
| `agent/` | Agent subsystems: types/events, run loop, tool executor, MCP bridge, interaction, prompt context, session persistence, verification, guardrails |
| `commands/` | Slash-command definitions, registry/dispatch — UI-independent |
| `config/` | Config load/precedence (`.scoderrc.json`, env, CLI flags) |
| `context/` | Prompt + context window: compaction, prompt builder, repo map, memory, skills, agent discovery |
| `io/` | Output port (`reporter`) + terminal adapter (`terminal.ts`, formerly `ui.ts`) |
| `llm/` | LLM protocol, providers, retry, model catalog |
| `mcp/` | MCP transports, manager, config import |
| `security/` | Permission checker, sandbox, shell scanner |
| `server/` | HTTP/SSE delivery |
| `session/` | Durable event store, JSONL logger, steering inbox, cost |
| `shared/` | Constants, version, JSON schema helpers |
| `tools/` | Tool implementations (path safety, file ops, shell, search, webfetch) |
| `tui/` | Ink UI: app composition, components, hooks, state reducer |
| `workspace/` | Build/verify, diff, snapshots, diagnostics, file index, watcher |

## Layer rules

Enforced by `node scripts/check-layers.mjs` (CI):

- Core domains must not import from `tui/`.
- `commands/` is UI-independent (no `tui/` imports).
- Import from the domain module directly — there are no root re-export facades.

Dependency graph: `docs/architecture-graph.md` (generated, `npm run check:layers:graph`).

## Where to read first

1. `cli/main.ts` — composition root (subcommand dispatch).
2. `agent.ts` — public Agent facade; subsystems in `agent/`.
3. `agent/run-loop.ts` — the autonomous loop.
4. `tui/app.tsx` — TUI composition; logic hooks in `tui/hooks/`.
