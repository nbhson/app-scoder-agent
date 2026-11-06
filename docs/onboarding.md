# Onboarding — 10 main flows

Read `src/README.md` + the domain READMEs first, then trace these flows.

1. **CLI startup** — `src/index.ts` (entry guard) → `src/cli/main.ts`
   (`main()` dispatch) → `src/cli/args.ts` (`parseArgs`).
2. **One-shot run** — `cli/main.ts` → `cli/run-once.ts` → `new Agent(cfg)` →
   `agent.ts` → `agent/run-loop.ts`.
3. **Autonomous loop step** — `agent/run-loop.ts`: stream LLM → tool calls →
   `agent/tool-executor.ts` → build/verify via `agent/verification.ts` →
   compaction via `context/compaction.ts`.
4. **Tool execution & permissions** — `agent/tool-executor.ts` →
   `security/permissions.ts` (auto/ask/readonly) → `tools/*` implementation →
   result events.
5. **Permission prompt (interactive)** — `agent/interaction.ts` broker → CLI
   readline (`cli/`) or TUI modal (`tui/permission-modal.tsx` via
   `permission_request` event).
6. **MCP tools** — `agent/mcp-bridge.ts` → `mcp/manager.ts` → transports
   (`mcp/transport-stdio.ts`, `mcp/transport-http.ts`, `mcp/sse.ts`).
7. **Session persistence & resume** — `agent/session-persistence.ts` writes
   manifest + events through `session/session.ts`; `agent.resume()` restores
   messages/memory/plan from the projection.
8. **Slash commands** — shared: `commands/definitions.ts` (metadata/parse) +
   `commands/registry.ts` (`dispatchCommand`); hosts: `cli/repl.ts` and
   `tui/hooks/use-command-host.ts`.
9. **TUI render pipeline** — agent events → `tui/hooks/use-event-queue.ts`
   (batching) → `tui/state.ts` (`applyEvent`) → `tui/app.tsx` layout +
   components.
10. **Prompt assembly** — `agent/prompt-context.ts` → `context/prompt.ts` +
    `context/prompt-builder.ts` (env, skills, agents, MCP blocks) +
    `context/repo-map.ts`.

Orientation check: you should be able to point at the file for each flow
without searching. If not, the domain README that failed you needs a fix.
