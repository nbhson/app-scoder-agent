# Refactor decisions (ADR log)

Short, append-only. Context: plan/REFACTOR-PLAN.md; constraint #1 everywhere:
no behavior/prompt/schema/event/CLI/permission changes.

## ADR-1: Move-only phases with legacy facades

Every structural change is a `git mv` + import rewrite + a facade at the old
path (`LEGACY PUBLIC PATH` header). Old `dist/<module>.js` paths keep working;
reverting a phase is a single commit revert. (Facades were removed after the
refactor — see ADR-5 supersession.)

## ADR-2: Reporter port instead of core → ui.ts

Core domains never import the terminal adapter. They emit through the
`Reporter` interface (`io/reporter.ts`); `console-reporter.ts` preserves the
classic output. This broke the core → TUI dependency direction.

## ADR-3: Agent decomposition by subsystem, run loop last

`src/agent.ts` shrank from ~2.000 lines to a facade + wiring by extracting
types → verification → mcp-bridge → interaction → tool-executor →
prompt-context → session-persistence → run-loop, in that order (least to most
coupled). The run loop was extracted only after every dependency was a module,
using a live-state `RunLoopRuntime` adapter so event/mutation order is
preserved exactly.

## ADR-4: Commands domain is UI-independent

`src/commands/` holds slash-command definitions and dispatch. It must not
import from `tui/`. REPL and TUI share `dispatchCommand`, so command behavior
cannot diverge between frontends. (The transcript export/search helpers were
removed together with the `/export` and `/search` commands.)

## ADR-5: Domain migration — Option A (keep all root facades)

Chosen over Option B (drop internal shims): the package does not commit to
internal module stability publicly, but preserving every `dist/*.js` path is
the safer default and satisfies constraint #1 without an approval gate.
Root keeps ~30 thin shims; `src/README.md` points readers at the domains.

**Superseded (post-refactor):** the root facades turned out to have exactly
one consumer — this repo's own test suite — because the package is a CLI app
(`bin: dist/index.js`, no `exports` map). All 40 root/`tui/` facades were
deleted and every importer was rewritten to domain paths (Option B). The
`src/` root now holds only `index.ts` and `agent.ts`.

## ADR-6: Performance changes require measured equivalence

Benchmarks in `scripts/bench.mjs` with a committed baseline
(`plan/baseline/`). A change merges only when the target case is ≥ 20 % faster
and no case regresses (> 5 % and > 1 ms). `buildRepoMap` single-walk was
reverted on measurement (−11…−16 % cold); `buildEnvInfo` memoization merged
(10.5 ms → ~0, output-identical).

## ADR-7: Latent bugs are not fixed during refactoring

Known issues (e.g. `fileIndex` cache not keyed by workdir — plan §9/B1) get
their own PR with a reproduction test and an explicit behavior decision.
