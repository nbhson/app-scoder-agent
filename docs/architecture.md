# Architecture

## High-Level Design

```
┌─────────────────────────────────────────────┐
│  CLI (src/index.ts)                         │
│  arg parsing, REPL, serve, tui, SIGINT       │
└───────────┬─────────────────┬───────────────┘
            │                 │
┌───────────▼───────────┐  ┌─▼─────────────────────────────┐
│  TUI (src/tui/)       │  │  Agent (src/agent.ts)          │
│  Ink/React full-     │  │  Closed-loop orchestrator      │
│  screen UI,          │─▶│  Guardrail Engine              │
│  renders the same    │  │  emits AgentEvent               │
│  AgentEvent stream   │  └┬──────────┬────────────────────┘
└──────────────────────┘   │          │
                            │          └──────────────────┐
                            ▼                              ▼
┌──────────────────────────────────┐  ┌────────────────────────────────┐
│  LLM Client (src/llm.ts)         │  │  Server (src/server.ts)       │
│  OpenAI-compatible + native      │  │  HTTP API + SSE               │
│  Anthropic provider              │  │  runs in background            │
└──────────────┬───────────────────┘  └────────────────────────────────┘
               ▼
┌───────────────────────────────────┐
│  Tool Registry (src/tools.ts)     │
│  + web_fetch (src/webfetch.ts)    │
│  + MCP (src/mcp.ts)               │
└───────────────┬────────────────────┘
                ▼
┌──────────────────────────────┐
│  Build Checker (src/build.ts)│
│  run build → exit 0 = stop   │
└──────────────────────────────┘
```

## Modules

### Core

| File | Purpose |
|------|---------|
| `agent.ts` | Autonomous loop orchestrator, emits typed AgentEvent stream |
| `llm.ts` | OpenAI-compatible LLM client (chat, streaming) |
| `provider-anthropic.ts` | Native Anthropic Messages API + SSE streaming |
| `provider-registry.ts` | Provider resolution + custom provider registry |
| `tools.ts` | Tool registry (read_file, write_file, edit_file, grep, etc.) |
| `build.ts` | Build command execution + exit code analysis |
| `permissions.ts` | Permission checker, catastrophic deny list, rule engine |
| `config.ts` | Config loading: rc file, env vars, CLI overrides |
| `guardrails.ts` | Guardrail Engine: doom-loop, text-only streak, wrap-up |
| `agents.ts` | Primary/subagent definitions (build/plan/review/custom) |
| `agents-guide.ts` | AGENTS.md hierarchy collection |
| `compaction.ts` | LLM-powered history summarization |
| `memory.ts` | Working memory / task state |
| `repo-map.ts` | Repository map for context |
| `snapshot.ts` | Git shadow snapshots before file writes |
| `steering.ts` | Steering / follow-up injection |
| `context.ts` | History trimming, mentions, completion detection |

### Context & Storage

| File | Purpose |
|------|---------|
| `session.ts` | Session persistence (v1 JSON + v2 event log) |
| `context.ts` | History trimming, mention expansion, completion detection |
| `compaction.ts` | LLM-powered history summarization |
| `snapshot.ts` | Git shadow snapshots before file write batches |
| `logger.ts` | JSONL event logger |
| `cost.ts` | Token usage + cost aggregation |

### Prompt

| File | Purpose |
|------|---------|
| `prompt.ts` | System prompt templates + PROMPT_VERSION |
| `prompt-builder.ts` | Build system prompt (tools, skills, agents, env info) |

### Integrations

| File | Purpose |
|------|---------|
| `mcp.ts` | MCP client (stdio + HTTP transport) |
| `webfetch.ts` | Web fetch with SSRF protection |
| `server.ts` | HTTP API server with SSE events |
| `model-catalog.ts` | Model catalog (context window, pricing) |

### TUI (src/tui/)

| File | Purpose |
|------|---------|
| `app.tsx` | Main TUI application (Ink/React) |
| `state.ts` | Pure reducer for UI state |
| `commands.ts` | Slash command parser + help formatter |
| `command-registry.ts` | Command dispatcher (REPL + TUI shared) |
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