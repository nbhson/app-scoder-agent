# Architecture

## Refactor status

The refactor (plan/REFACTOR-PLAN.md) is complete through the domain migration (Phase 8.1, Option A):

- Source is domain-oriented — see `src/README.md` and each domain's README (`agent/`, `cli/`, `commands/`, `config/`, `context/`, `io/`, `llm/`, `mcp/`, `security/`, `server/`, `session/`, `shared/`, `tools/`, `tui/`, `workspace/`).
- The `src/` root holds only `index.ts` (CLI entry) and `agent.ts` (Agent facade); legacy root re-export facades were removed once the test suite moved to domain paths.
- `src/agent.ts` is the public Agent facade; subsystems live in `src/agent/` (run loop, tool executor, MCP bridge, interaction, prompt context, session persistence, verification, guardrails, types).
- Slash commands are UI-independent in `src/commands/`; both the REPL and the TUI dispatch through `dispatchCommand`.
- `src/index.ts` is a thin entry; the CLI lives in `src/cli/`.
- `npm run check:layers` guards core/TUI boundaries; the generated graph is in `docs/architecture-graph.md`.

No prompt, event, tool schema, CLI, or permission contract is changed by these moves.

## High-Level Design

```
┌─────────────────────────────────────────────┐
│  CLI (src/index.ts → src/cli/)                         │
│  arg parsing, REPL, serve, tui, SIGINT       │
└───────────┬─────────────────┬───────────────┘
            │                 │
┌───────────▼───────────┐  ┌─▼─────────────────────────────┐
│  TUI (src/tui/)       │  │  Agent (src/agent.ts + src/agent/)          │
│  Ink/React full-     │  │  Closed-loop orchestrator      │
│  screen UI,          │─▶│  Guardrail Engine              │
│  renders the same    │  │  emits AgentEvent               │
│  AgentEvent stream   │  └┬──────────┬────────────────────┘
└──────────────────────┘   │          │
                            │          └──────────────────┐
                            ▼                              ▼
┌──────────────────────────────────┐  ┌────────────────────────────────┐
│  LLM (src/llm/)         │  │  Server (src/server/)       │
│  OpenAI-compatible + native      │  │  HTTP API + SSE               │
│  Anthropic provider              │  │  runs in background            │
└──────────────┬───────────────────┘  └────────────────────────────────┘
               ▼
┌───────────────────────────────────┐
│  Tool Registry (src/tools/registry.ts) │
│  + web_fetch (src/tools/webfetch.ts)    │
│  + MCP (src/mcp/)               │
└───────────────┬────────────────────┘
                ▼
┌──────────────────────────────┐
│  Build Checker (src/workspace/build.ts)│
│  run build → exit 0 = stop   │
└──────────────────────────────┘
```

## Modules

### Core

| File | Purpose |
|------|---------|
| `agent.ts` | Public facade: `Agent`, `EVENT_SCHEMA_VERSION`, `resolvePrimaryConfig` |
| `agent/run-loop.ts` | Autonomous loop (LLM → tools → build/verify → retry) |
| `agent/tool-executor.ts` | Tool dispatch, permission/MCP routing, post-effects |
| `agent/mcp-bridge.ts` | MCP lifecycle + direct calls for the agent |
| `agent/interaction.ts` | Permission/question broker |
| `agent/prompt-context.ts` | Prompt composition + skill staging |
| `agent/session-persistence.ts` | Manifest/snapshot persistence + resume projection |
| `agent/verification.ts` | Build/test/typecheck/lint verification |
| `agent/guardrails.ts` | Guardrail Engine: doom-loop, text-only streak, wrap-up |
| `agent/types.ts` | Public Agent contracts + event schema |
| `llm/llm.ts` | OpenAI-compatible LLM client (chat, streaming) |
| `llm/provider-anthropic.ts` | Native Anthropic Messages API + SSE streaming |
| `llm/provider-registry.ts` | Provider resolution + custom provider registry |
| `llm/model-catalog.ts` | Model catalog (context window, pricing) |
| `llm/retry.ts` | Retry/backoff helpers |
| `tools/` | Tool contracts, file/search/command implementations, webfetch, ordered registry |
| `workspace/build.ts` | Build command execution + exit code analysis |
| `security/permissions.ts` | Permission checker, catastrophic deny list, rule engine |
| `config/config.ts` | Config loading: rc file, env vars, CLI overrides |
| `context/agents.ts` | Primary/subagent definitions (build/plan/review/custom) |
| `context/agents-guide.ts` | AGENTS.md hierarchy collection |
| `context/compaction.ts` | LLM-powered history summarization |
| `context/memory.ts` | Working memory / task state |
| `context/repo-map.ts` | Repository map for context |
| `workspace/snapshot.ts` | Git shadow snapshots before file writes |
| `session/steering.ts` | Steering / follow-up injection |
| `context/context.ts` | History trimming, mentions, completion detection |

### Context & Storage

| File | Purpose |
|------|---------|
| `session/session.ts` | Session persistence (v1 JSON + v2 event log) |
| `session/logger.ts` | JSONL event logger |
| `session/cost.ts` | Token usage + cost aggregation |
| `workspace/snapshot.ts` | Git shadow snapshots before file write batches |

### Prompt

| File | Purpose |
|------|---------|
| `context/prompt.ts` | System prompt templates + PROMPT_VERSION |
| `context/prompt-builder.ts` | Build system prompt (tools, skills, agents, env info) |

### Integrations

| File | Purpose |
|------|---------|
| `mcp/` | MCP types, transports, connection state machine, manager, config import |
| `server/server.ts` | HTTP API server with SSE events |

### Commands (src/commands/)

| File | Purpose |
|------|---------|
| `commands/definitions.ts` | Slash command metadata, parser, help formatter |
| `commands/registry.ts` | Command dispatcher shared by REPL + TUI |

### TUI (src/tui/)

| File | Purpose |
|------|---------|
| `app.tsx` | TUI composition + layout (Ink/React) |
| `hooks/` | Logic hooks: event queue, submit, keybinds, scroll, command host, session resume |
| `state.ts` | Pure reducer for UI state |
| `selectors.ts` | Pure selectors (latestPlan, visibleWindow, toolPhase, estimateItemRows) |
| `chat-views.tsx` | Chat message renders |
| `chrome.tsx` | TUI chrome (header, status bar) |
| `input.tsx` | User input component |
| `permission-modal.tsx` | Permission approval modal |
| `sidebar.tsx` | Live session sidebar |
| `theme.tsx` | Theme definitions (3 built-in + custom) |
| `vim.ts` | Vim keybindings (normal/insert mode) |
| `mouse.ts` | Mouse wheel scroll handling |

## Key Design Decisions

### ESM Only
```json
{ "type": "module" }
```
Native `import.meta.url`, top-level await, better tree-shaking.

### TypeScript Target
ES2022, `NodeNext` module resolution, strict mode, no declaration files in output.

### AgentEvent Stream
Agent emits typed events (`AgentEvent` union type). Same stream drives:
- REPL terminal output
- Full-screen TUI
- HTTP SSE API

### Guardrail Rule Engine
Declarative rules — configurable thresholds without touching runLoop. Each rule is a pure function over step context.

### JSONL for Logs & Sessions
Append-friendly, easy to stream and tail. v2 session: event log + in-memory projection.
