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
| Probe sends the API key and reads `default_generation_settings.n_ctx` (llama.cpp puts the window there, not at the top level) | local server reported 16.128 token — the old probe returned `null` (401 on `/props`) so the agent planned against 128k | merged (follow-up) |
| MCP schema cap scales with the **real** window (`SCHEMA_SHARE_OF_WINDOW` = 35 % of window minus builtin schema) | 16k window: 37 → 24 advertised tools, fixed cost 14.480 → 11.315 real tokens per call (−22 %) | merged (follow-up) |
| Fixed per-call cost calibrated from the engine's own `prompt_tokens` (`fixedSource: "measured"`) | cl100k counted the schema within 1 %, but missed ChatML framing: 10.305 real vs 8.065 estimated (−22 %) | merged (follow-up) |
| `maxTokens` reserve clamped to 25 % of what is left after the schema | window 16k: budget 2.000 (floor → trim almost every step) → 7.269 | merged (follow-up) |
| `promptChars` split into `messageChars` / `schemaChars` in `llm_usage.perf` | one log line now answers "where do 12k tokens come from" | merged (follow-up) |

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
- on a small window the MCP cap tightens itself: the total schema (builtin +
  MCP) may not exceed `SCHEMA_SHARE_OF_WINDOW` (35 %) of the *probed* context
  window. `limits.mcpSchemaTokens: 0` still means "no cap at all".
- the budget subtracts the fixed cost the engine actually reported
  (`llm_usage.perf.fixedSource: "measured"`), not just the counted schema —
  cl100k does not know the chat template.

Measure:

```bash
node scripts/measure-mcp-schema.mjs            # baseline schema cost
node scripts/measure-mcp-schema.mjs --cap 6000 # projected after the schema budget
node scripts/bench-context.mjs                 # wasted prefill: legacy vs current strategy
```

For engine ground truth on a *real* request (not an estimate), capture the
exact body the agent sends and replay it with `max_tokens: 1` — the server
then reports `prompt_tokens` and `prompt_tokens_details.cached_tokens` with
its own tokenizer and chat template:

```bash
SCODER_CAPTURE_DIR=/tmp/cap node scripts/capture-prompt-proxy.mjs 8099 http://0.0.0.0:8080 &
# point baseUrl at http://127.0.0.1:8099/v1, run the agent, then:
node scripts/measure-prompt-anatomy.mjs anatomy  /tmp/cap 1        # FULL / -tools / -system split
node scripts/measure-prompt-anatomy.mjs blocks   /tmp/cap 1        # cost of each dynamic system block
node scripts/measure-prompt-anatomy.mjs warmcold /tmp/cap 1        # identical replay vs 1-char prefix change
node scripts/measure-prompt-anatomy.mjs scatter  /tmp/cap 1 4 --pin 0  # interleaved prompts, slot pinning
```

Ask the server for ground truth instead of estimating (needs the API key the
server was started with):

```bash
curl -s -H "Authorization: Bearer $KEY" localhost:8080/props | jq '.default_generation_settings.n_ctx, .total_slots'
curl -s -H "Authorization: Bearer $KEY" localhost:8080/slots | jq '[.[] | {id, n_ctx, n_prompt_tokens, n_prompt_tokens_cache}]'
curl -s -H "content-type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"content":"chào bạn","add_special":false}' localhost:8080/tokenize | jq '.tokens | length'
```

In a real run, the `llm_usage.perf` block in `.scoder/logs/<session>.jsonl`
answers the same question directly: `prefixReused: false` plus
`cached_tokens: 0` means that step re-prefilled the whole prompt.

### Where the tokens go (measured, llama.cpp, Qwen3.6-35B-IQ2_M, `n_ctx` 16.128)

Tokenized by the server itself (`POST /tokenize`), and by comparing
`prompt_tokens` of two requests that differ only in `tools`:

| Part of a "chào" prompt | chars | real tokens |
|---|---|---|
| 37 tool schemas (13 builtin + 24 MCP kept by the 6k cap) | 35.916 | ~10.320 |
| system prompt (V6 base + env + agents/MCP blocks + repo map) | 15.114 | 4.156 |
| — of which the repo map alone | 8.113 | 2.561 |
| the word "chào" | 5 | 2 |
| **total** | 51.034 | **14.480** |

So a greeting costs 14.480 input tokens: essentially all of it is fixed
overhead, and on a 16k window that overhead alone is 90 % of the context.
Measured knobs:
`mcpTools.include` (or `mcpServers.<server>.enabled: false`) removes the
largest share; `repoMap: false` saves 2.561 more; `limits.mcpSchemaTokens: 0`
turns the cap off entirely. The estimator is accurate on schema *content*
(2.086 estimated vs 2.098 real for the builtins) but blind to ChatML framing,
which is why the run-time calibration above exists.

None of the 14k is a hard floor: the instruction text alone is 954 tokens and
ChatML framing costs ~10; everything else is a choice (schema disclosure,
repo map, per-turn prefill count). The block-by-block breakdown and the
ranked reductions are in `plan/performance-issue.md` §13.

### Cold vs warm is the whole story on a local chat

Same prompt, same process, only the KV state of the server differs:

| Run | `cached_tokens` | TTFT | total |
|---|---|---|---|
| cold, 14.480 token (before the schema cap) | 0 | — | 53–56 s |
| cold, 11.315 token (after the window-aware cap: 24 tools) | 0 | 36.2–38.2 s (≈300 tok/s prefill) | 44 s |
| warm (identical prefix reused) | 14.476 / 14.480 | 0.12–2.5 s | 4.5–6.9 s |

`llama.cpp` reports `total_slots: 2` on this machine: consecutive requests land
on different slots and each slot has its own cache, so a "warm" run can still
pay a full prefill. Run the server with one slot (`--parallel 1` / `-np 1`), or
keep `n_ctx` in one slot large enough, if single-message latency matters. The
request body's `slot_id` field is honored by the server and pins a slot from
the client side: with two 8.5k/11.3k-token prompts interleaved, unpinned gave
2/6 cold rounds (17.9–38.0 s), `slot_id: 0` gave 0/6 (73–81 ms). There
is no API to clear a slot cache (`POST /slots {"action":"clear"}` 404s), so to
reproduce a cold run, restart the server.

## Non-goals

- Micro-optimizing `estimateTokens`/`trimHistory` CPU time (already fast; the
  fix above is about *what* they change, not how long they take).
- Cross-process caches without a complete invalidation key.
- Lazily discovering MCP tools at call time (would bypass the per-server
  permission/allowlist checks) — use `mcpTools` + `limits.mcpSchemaTokens`.
