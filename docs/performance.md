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

## Non-goals

- Micro-optimizing `estimateTokens`/`trimHistory` (already fast enough).
- Cross-process caches without a complete invalidation key.
