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
| `SCODER_SERVER_TOKEN` | — | `scoder serve` auth token |
| `SCODER_WEB_ALLOW_PRIVATE` | — | `1` to allow localhost/private in web_fetch |
| `SCODER_NO_APIKEY_WARNING` | — | `1` to suppress apiKey-in-rc warning |
| `SCODER_AGENT` | — | Primary agent name (build/plan/review/custom) |
| `SCODER_REASONING` | — | `1` to enable reasoning/thinking output |
| `SCODER_SKILLS` | `~/.scoder/skills` | Skills directory override |
| `SCODER_CONFIG` | `~/.scoder/config.json` | Global config file override |
| `SCODER_NO_SAVE` | — | `1` to disable session auto-save |
| `SCODER_NO_WATCH` | — | `1` to disable file watching |
| `SCODER_PLAIN` | — | `1` for plain (monochrome) output |
| `SCODER_THEME` | — | Palette name (mission/paper/mono/light/high-contrast/solarized) |
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

## Config Precedence

1. **CLI flags** — `-m`, `--base-url`, `-k`, `--provider`, `-B`
2. **Environment variables** — `SCODER_API_KEY`, `SCODER_BASE_URL`, etc.
3. **`.scoderrc.json`** — project root, merged with global `~/.scoder/config.json`
4. **Built-in defaults**

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
| `toolOutputChars` | 8000 | Budget for **one tool result in history**; `read_file` cuts at it line-aware and prints the `offset` to continue with |
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
| `limits.toolOutputChars` | 6000 | Smaller per-tool-result history budget |
| `limits.mcpSchemaTokens` | 6000 | 46 GitHub-MCP tools cost ~12k tokens **per call** |
| `selfReview` | false | One extra LLM turn with a nearly full prompt |

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

## Security Notes

- Never commit `apiKey` in `.scoderrc.json` — add to `.gitignore`
- Prefer `SCODER_API_KEY` environment variable
- Run `scripts/check-secrets.mjs` as pre-commit hook to scan for leaked keys
