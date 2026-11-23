# Configuration

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCODER_API_KEY` | — | API key (required) |
| `SCODER_MODEL` | `gpt-4o-mini` | Model name |
| `SCODER_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `SCODER_BUILD_CMD` | auto-detected | Build/compile command |
| `SCODER_MAX_STEPS` | `40` | Max loop iterations |
| `SCODER_PERMISSION` | `auto` | Permission mode: `auto` \| `ask` \| `readonly` |
| `SCODER_STREAM` | `1` | `0` to disable streaming |
| `SCODER_RETRY_LADDER_MS` | `10000,30000,60000,180000,300000,600000` | Escalating retry waits (ms) for transient LLM failures |
| `SCODER_SERVER_TOKEN` | auto-generated | `scoder serve` bearer token (auth is mandatory) |
| `SCODER_WEB_ALLOW_PRIVATE` | — | `1` to allow localhost/private in web_fetch |
| `SCODER_TRUST_PROJECT` | — | `1` = accept this directory's project config for one run (see Project Config Trust) |
| `SCODER_NO_APIKEY_WARNING` | — | `1` to suppress apiKey-in-rc warning |
| `SCODER_AGENT` | — | Primary agent name (build/plan/review/custom) |
| `SCODER_REASONING` | — | `1` to enable reasoning/thinking output |
| `SCODER_SKILLS` | `~/.scoder/skills` | Skills directory override |
| `SCODER_CONFIG` | `~/.scoder/config.json` | Global config file override |
| `SCODER_NO_SAVE` | — | `1` to disable session auto-save |
| `SCODER_NO_WATCH` | — | `1` to disable file watching |
| `SCODER_PLAIN` | — | `1` for plain (monochrome) output |
| `SCODER_THEME` | — | Palette name (mission/paper/mono/light/high-contrast/solarized) |
| `SCODER_NOTIFY` | `1` | `0` disables the desktop notification sent when a run finishes while the terminal is unfocused |
| `SCODER_NO_MOTION` | — | `1` to disable animations |

Legacy env vars (still work):
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`
- `ANTHROPIC_API_KEY`

## Config File (.scoderrc.json)

Create `.scoderrc.json` in your project root:

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o-mini",
  "theme": "mission",
  "notify": true,
  "buildCmd": "npm run build",
  "maxSteps": 40,
  "permission": "auto",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

See [.scoderrc.example.json](../.scoderrc.example.json) for full config reference.

## Project Config Trust

A `.scoderrc.json` checked into a repo is honored ONLY after the directory is
trusted (once, out-of-band) — otherwise its sensitive keys are dropped with a
warning: `baseUrl`, `apiKey`, `providers`, `mcpServers`, `buildCmd`,
`verifyCmds`, `formatter`, `permission`, `permissions`, `sandbox`,
`shellEnvAllow`. `~/.scoder/config.json` and CLI flags are never filtered.

```bash
scoder trust [path|--list|--revoke <path>]   # ~/.scoder/trust.json
SCODER_TRUST_PROJECT=1 scoder …               # one-shot (CI/scripts)
```

Committed `.scoder/permissions.local.json` (saved approvals) requires the same
trust. See `docs/commands.md` for details.

## Sandbox (`sandbox`)

`run_command` can execute inside an OS-level sandbox: `readonly` (no writes
anywhere) or `workspace-write` (writes allowed only in the workspace + `/tmp`):

```json
{ "sandbox": { "mode": "workspace-write", "wrapper": "sandbox-exec", "strict": true } }
```

- The wrapper is auto-detected per platform (`sandbox-exec` on macOS, `bwrap`
  on Linux; `docker` can be forced).
- **Fail closed by default:** an explicitly-enabled mode whose wrapper binary
  is missing makes `run_command` REFUSE to run rather than silently executing
  unsandboxed — a requested sandbox is a security promise. Set
  `strict: false` to get the old warn-and-run behavior.
- `mode: "off"` (the default when unset) runs commands directly, unchanged.

## Config Precedence

1. **CLI flags** — `-m`, `--base-url`, `-k`, `--provider`, `-B`, `--theme`
2. **Environment variables** — `SCODER_API_KEY`, `SCODER_BASE_URL`, etc.
3. **`.scoderrc.json`** — project root, merged with global `~/.scoder/config.json`
4. **Built-in defaults**

The `theme` key picks the TUI palette (`mission` | `paper` | `mono` | `light` |
`high-contrast` | `solarized`); `.scoder/theme.json` in the project still wins over
it (it also accepts inline per-color overrides).

## Runtime Limits (`limits`)

Numeric thresholds, all optional. Defaults live in `LIMIT_DEFAULTS`
(`src/config/config.ts`) — a wrong value (0, negative, string) is ignored.

```json
{
  "limits": {
    "requestTimeoutMs": 120000,
    "maxOutputChars": 20000,
    "toolConcurrency": 4,
    "renderCap": 200,
    "toolOutputChars": 8000,
    "mcpSchemaTokens": 0,
    "buildTimeoutSecs": 600
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `requestTimeoutMs` | 120000 | LLM request timeout |
| `maxOutputChars` | 20000 | Hard cap on one tool's raw output |
| `toolConcurrency` | 4 | Parallel tool calls per step |
| `renderCap` | 200 | Tail items rendered by the TUI |
| `toolOutputChars` | 6000 (local: 6000–16000 by window) | Budget for **one tool result in history**; `read_file` cuts at it line-aware and prints the `offset` to continue with. On a local engine with no explicit value the budget adapts to the probed context window (`plan/FILE-READ-PERF-PLAN.md` P1) |
| `mcpSchemaTokens` | 0 (= off) | Ceiling for all MCP tool schemas advertised per call; tools past the ceiling are not advertised (warning names the count). On a small context window the effective ceiling is lowered automatically: total schema (builtins + MCP) is kept ≤ 35 % of the probed window |
| `buildTimeoutSecs` | 600 | Timeout of one verify command (build/test/typecheck/lint) |

## Local Models

When `baseUrl` points at a loopback host (`localhost`, `127.0.0.1`, `::1`,
`0.0.0.0`, `*.local`) the agent applies a profile tuned for slow prefill —
each change is skipped if you set the key yourself:

| Applied | Value | Why |
|---|---|---|
| `maxSteps` | 24 | 40 steps on a local model is hours |
| `limits.requestTimeoutMs` | 600000 | A 30k-token prefill can exceed 120s |
| `limits.mcpSchemaTokens` | 6000 | 46 GitHub-MCP tools cost ~12k tokens **per call** |
| `selfReview` | false | One extra LLM turn with a nearly full prompt |

`limits.toolOutputChars` is deliberately **not** pinned by the profile: on a
local engine it adapts to the *probed* context window —
`clamp(0.17 × window, 6000, 16000)` chars, so small windows keep the old 6000
budget while a 96k-slot server reads a 28 KB file in 2 steps instead of 6
(`plan/FILE-READ-PERF-PLAN.md`). Set the key explicitly to win over the
adaptive rule.

Disable with `"localProfile": false`, or override individual keys (they win).
`repoMap` and `snapshots` are deliberately **not** disabled: the repo map lives
in the stable system-prompt prefix (no cache cost) and snapshots are local git
ops that cost no tokens.

Related top-level keys:

- `"verifyCache": false` — re-run build/test/typecheck/lint even when no file
  changed (default: reuse the last passing result, keyed on a workspace
  fingerprint).
- `"contextWindow": 32768` — pin the model window. Without it the agent asks
  the server (Ollama `/api/show` `num_ctx`, llama.cpp `/props`, vLLM
  `max_model_len`) before falling back to the catalog/128k guess.
- `"mcpTools": { "include": [...], "exclude": [...] }` — global allow/deny for
  MCP tool names (see [mcp.md](mcp.md)).
- `"warmup": false` — skip the background prefix-prefill request an interactive
  session (REPL/TUI) sends at startup: same system prompt + tool schemas as the
  first real call, `max_tokens: 1`, response discarded. It moves model
  cold-load, MCP connect and the 20–60k-token prefill off the first message's
  path (cache write on Anthropic, KV prefill on llama.cpp/Ollama). One extra
  API request per session start; `scoder run`/`serve` never send it. On loopback
  URLs an idle session additionally re-warms every 4 minutes (keeps the engine
  loaded through Ollama's `keep_alive` — see
  [plan/FILE-READ-PERF-PLAN.md](../plan/FILE-READ-PERF-PLAN.md)). See
  [plan/WARMUP-PLAN.md](../plan/WARMUP-PLAN.md).

## Permission Modes

| Mode | Behavior |
|------|---------|
| `auto` (default) | Runs shell commands without confirmation |
| `ask` | Prompts before each shell command |
| `readonly` | Shell commands disabled; agent can only read/list files |

## Provider Examples

```jsonc
// OpenAI
{ "model": "gpt-4o", "baseUrl": "https://api.openai.com/v1" }

// Anthropic (auto-detected when model starts with 'claude-')
{ "model": "claude-sonnet-4-5" }

// DeepSeek
{ "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1" }

// Groq
{ "model": "llama-3.3-70b-versatile", "baseUrl": "https://api.groq.com/openai/v1" }

// Ollama (local)
{ "model": "qwen2.5-scoder:32b", "baseUrl": "http://localhost:11434/v1", "apiKey": "ollama" }
```

## Custom Providers & Models (opencode-style `provider` block)

Declare any OpenAI-compatible / Anthropic-compatible endpoint with its own
model list — same shape as opencode's config:

```json
{
  "provider": {
    "box-api": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Box API",
      "options": {
        "baseURL": "https://api.ai-box.vn/v1",
        "apiKey": "{env:BOX_API_KEY}"
      },
      "models": {
        "kimi-k3": { "name": "kimi-k3" },
        "qwen3.8-flash": { "name": "qwen3.8-flash", "limit": { "context": 262144 }, "cost": { "input": 0.2, "output": 0.8 } }
      }
    }
  },
  "model": "box-api/kimi-k3"
}
```

- **Refs**: `"model": "box-api/kimi-k3"` or bare `"qwen3.8-flash"` — a bare id
  that exactly one configured provider declares routes there automatically
  (ambiguous ids print a warning and keep the active provider).
- **`npm`** only selects the runtime: `@ai-sdk/openai*` → OpenAI-compatible,
  `@ai-sdk/anthropic` → native Anthropic. No npm package is ever installed or
  imported (the agent has zero runtime dependencies); an unknown `npm` falls
  back to OpenAI-compatible with a one-line warning.
- **Keys** resolve in order: `--api-key` flag → `SCODER_API_KEY` → the
  provider's `apiKeyEnv` var → rc inline `options.apiKey` → legacy rc
  `apiKey`. Inline values support `{env:VAR}` — use it, literal keys print a
  commit-risk warning. An inline key belongs to ITS provider: `/model`
  hot-swaps never carry it to another endpoint.
- **`limit` / `cost`** feed the sidebar ctx %, auto-compaction and
  `scoder cost` — rc metadata always wins over the models.dev catalog.
- `scoder models` lists configured providers first (`SOURCE=config`), then the
  catalog. `/model` (no args) shows the resolved display name + context.
- The legacy `providers.<id>` format still works and merges (the new block
  wins on id collisions). In untrusted directories the whole `provider` block
  is dropped until you run `scoder trust`.

## Model Router (`router`)

With several models configured, the router picks one **per agent turn** —
cheap models for lookups, the large model for edits/builds. Disabled by
default; enabling it changes nothing until you opt in to routing:

```json
{
  "provider": { "...": "see above" },
  "router": {
    "enabled": true,
    "tiers": {
      "small": ["box-api/qwen3.8-flash", "box-api/kimi-k2.7-code"],
      "large": ["box-api/kimi-k3"]
    },
    "fallback": "box-api/kimi-k3",
    "signals": { "smallMaxCtxTokens": 16000, "largeToolSchemaChars": 30000 },
    "rules": [{ "when": "phase == edit", "use": "large" }],
    "escalate": { "buildFails": 2, "stickyMinSteps": 2 },
    "judge": null
  },
  "model": "auto"
}
```

- **Two switches, deliberately.** `"enabled": true` builds the router;
  routing only runs when the model is `"auto"` (rc / `-m auto` /
  `/model auto`). A concrete `"model"` = PINNED — byte-identical to the
  old behavior, zero router overhead, zero `route_decision` events.
  `/model <provider/model>` pins again mid-session; `/model auto`
  resumes routing. No restart needed either way.
- **Decision layers** (win order: pin > rules > judge > score > hysteresis):
  L1 scores the turn (history size, phase from the last tool call, tool
  schema weight, plan/wrap-up steps); L2 `rules` are "khi" expressions
  (`phase|step|tokens|tools` with `== != >= <=`) that force a tier;
  L3 hysteresis escalates small→large after `buildFails` consecutive build
  failures (and locks large until the build passes), resists tier
  flapping within `stickyMinSteps`, and demotes only after 3 clean steps;
  L4 `judge` (optional, see below) asks a cheap model to name the exact
  target when L1 is undecided.
- **Tiers**: refs must be declared in your `provider` block (stricter than
  `/model` — a tier typo would silently route half your traffic). Bad refs
  print a warning and are dropped. Without `tiers`, models with declared
  `cost` auto-split (cheapest half → small). `fallback` (default: the
  largest-context large model) is the deterministic way home whenever the
  router is undecided or errors — routing can never fail a run.
- **`judge`**: `null` (default) = pure 3-layer pipeline, ZERO extra
  requests. An object `{"model": "box-api/qwen3.8-flash", "scope":
  "gray", "timeoutMs": 2000, "minConfidence": 0.6}` adds a 4th layer that
  picks the exact model inside gray-band turns only (`scope`: `gray` |
  `first` | `always`). Hallucinated refs, low confidence and timeouts fall
  back to the L1+L2 decision with the verdict audited.
- **Observability**: every routed turn appends a `route_decision` event to
  the session JSONL (schema v3). `/router` shows mode, tiers and the last
  decision; `scoder cost --router` prints the per-model cost breakdown and
  estimated savings vs. running everything on the large tier.

## Security Notes

- Never commit `apiKey` in `.scoderrc.json` — add to `.gitignore`
- Prefer `SCODER_API_KEY` environment variable
- Run `scripts/check-secrets.mjs` as pre-commit hook to scan for leaked keys
