# Performance

Policy (plan/REFACTOR-PLAN.md §Phase 6): only merge optimizations that are
(a) measured, (b) output-identical (golden comparison), (c) easy to roll back.

## Benchmark

```bash
node scripts/bench.mjs                              # print JSON
node scripts/bench.mjs --compare plan/baseline/bench-<sha>.json
```

`--compare` exits 1 when a case regresses > 5% **and** > 1 ms (noise floor —
sub-10 ms cases jitter several percent on unchanged code).

Workloads: synthetic repo (2.000 files — the repo-map walk cap), 100 skills,
`buildRepoMap` cold/warm, `repoMapKey`, `renderRepoMap`, `buildEnvInfo`,
`discoverSkills`, `findSkill`, CLI cold start (`--help`).

Baseline: `plan/baseline/bench-dec14e1.json`.

## Decisions (measured)

| Change | Result | Verdict |
|---|---|---|
| `buildEnvInfo` memoized per (workdir, day, platform, node) | 10.5 ms → ~0 | merged |
| `buildRepoMap` single walk | cold −11…−16 % | **reverted** — below the 20 % acceptance threshold; render dominates (32 ms), walk is 7 ms |
| `discoverSkills`/`findSkill` caching | ~1.8 ms total | skipped — freshness semantics of `/skill` would change |
| TUI `visibleWindow` render bound | — | deferred — changes terminal output outside viewport; needs explicit approval + scroll tests |
| History trim is **conditional** (`history-trim` guardrail + cooldown 3 steps, hysteresis to 70 % of budget) instead of every step | 40-step simulation, 128k window: wasted re-prefill 1.13M → 174k tokens (−85 %), KV-cache reuse 0.51 → 0.93, trim events 20 → 1 | merged (P0-1) |
| `read_file` truncates line-aware at `limits.toolOutputChars` (8k default, 6k local profile) with an explicit "read the next chunk at offset N" hint | on top of P0-1: total prompt tokens −46 % (2.61M → 1.42M), re-prefill −70 % | merged (P0-2) |
| MCP schema budget `limits.mcpSchemaTokens` + global allowlist `mcpTools` | schema 16,222 → 8,570 wire tokens with cap 6k (53 → 24 advertised tools) | merged (P0-3), default off |
| Tool schema counted in context pressure (`estimateSchemaTokens`) | compaction/trim now trigger ~16k tokens earlier — matching the real prompt | merged (P1-1) |
| Context window probed from the server (`/api/show`, `/props`, `max_model_len`) | replaces the 128k guess for Ollama/llama.cpp/vLLM | merged (P1-1) |
| Verification cache keyed on workspace fingerprint (`verifyCache`) | repeated passing verify is skipped; only PASS results cached | merged (P1-2) |
| Per-call perf log (`llm_usage.perf`: TTFT, prefill tok/s, prompt/history hash, `prefixReused`) | makes KV-cache invalidation visible in JSONL | merged (P1-3) |

## Local engines (KV-cache)

A local server only reuses its KV cache for a byte-identical prompt **prefix**.
Anything that rewrites history in the middle (in-place tool-result pruning,
aggressive trim) costs a full re-prefill on every following call — the single
biggest latency factor for `localhost` models. Rules the code follows:

- history is append-only while under budget (`trimHistory` returns the same
  array — `plan/performance-issue.md` RC-1);
- trim happens at most every `TRIM_COOLDOWN_STEPS` (3) steps and cuts to 70 %
  of the budget (`TRIM_RECOVERY_FRACTION`), not to the threshold;
- one tool result enters history at `limits.toolOutputChars` size, with a hint
  telling the model how to read the next chunk instead of re-reading;
- `baseUrl` on a loopback host switches on the local profile
  (`localProfile`): `maxSteps` 24, `limits.requestTimeoutMs` 600s,
  `limits.toolOutputChars` 6000, `limits.mcpSchemaTokens` 6000, `selfReview`
  off. `repoMap` and `snapshots` stay ON — the repo map is part of the stable
  system prompt and snapshots cost no tokens.

Measure:

```bash
node scripts/measure-mcp-schema.mjs            # baseline schema cost
node scripts/measure-mcp-schema.mjs --cap 6000 # projected after the schema budget
node scripts/bench-context.mjs                 # wasted prefill: legacy vs current strategy
```

In a real run, the `llm_usage.perf` block in `.scoder/logs/<session>.jsonl`
answers the same question directly: `prefixReused: false` plus
`cached_tokens: 0` means that step re-prefilled the whole prompt.

## Non-goals

- Micro-optimizing `estimateTokens`/`trimHistory` CPU time (already fast; the
  fix above is about *what* they change, not how long they take).
- Cross-process caches without a complete invalidation key.
- Lazily discovering MCP tools at call time (would bypass the per-server
  permission/allowlist checks) — use `mcpTools` + `limits.mcpSchemaTokens`.
