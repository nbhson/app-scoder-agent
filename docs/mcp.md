# MCP Integration

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) extends scoder with external tools and data sources.

## Config Syntax

In `.scoderrc.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "authorization": "Bearer {env:MCP_TOKEN}" }
    }
  }
}
```

## Transport Types

### stdio (Local)
```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

### HTTP (Remote)
```json
{
  "mcpServers": {
    "my-remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "authorization": "Bearer {env:TOKEN}" }
    }
  }
}
```

## Tool Naming

MCP tools are exposed to the LLM as:
```
mcp__<server>__<tool>
```

Example: `mcp__filesystem__read_file`

## Security Notes

⚠️ **MCP tools bypass the built-in permission system** (no command classification, no diff preview). They run unsandboxed in `auto`/`ask` mode.

- In `readonly` mode, MCP tools are **disabled entirely**
- Only add MCP servers you trust

## Environment Substitution

Use `{env:VAR}` in `env` or `headers` to inject secrets:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
    }
  }
}
```

## MCP Command (REPL/TUI)

List configured servers and tools:

```bash
scoder
> /mcp
> /mcp github
> /mcp github create_issue
```

## Hot Reload

MCP servers configured in `.scoderrc.json` are connected at startup. To add/remove servers mid-session, edit the config and the agent will pick up changes at the next turn.

## Per-Server Governance

Each server entry supports additional fields:

```json
{
  "mcpServers": {
    "db": {
      "command": "node",
      "args": ["db-server.js"],
      "enabled": true,
      "trust": "ask",
      "tools": { "include": ["query_*"], "exclude": ["drop_*"] },
      "timeoutMs": 60000,
      "type": "stdio"
    }
  }
}
```

- `enabled` — `false` skips spawning the server entirely
- `trust` — `auto` (default) \| `ask` \| `readonly` \| `deny`; `readonly` servers are never spawned and their tools are disabled
- `tools.include` / `tools.exclude` — glob filters applied to discovered tool names
- `timeoutMs` — per-server request timeout (default 120s)
- `type` — force `stdio` or `http` transport (auto-detected from `url`/`command`)

## Global Tool Filter & Schema Budget

Every advertised tool costs schema tokens on **every** LLM call. GitHub MCP
alone measured 11,773 tokens for 46 tools (`node scripts/measure-mcp-schema.mjs`),
which is paid even when the task has nothing to do with GitHub.

Two levers, applied in this order:

```json
{
  "mcpTools": {
    "include": ["mcp__github-mcp__get_*", "mcp__github-mcp__search_code"],
    "exclude": ["mcp__github-mcp__*codespaces*"]
  },
  "limits": { "mcpSchemaTokens": 6000 }
}
```

- `mcpTools` (`src/mcp/tool-filter.ts`) — same glob syntax as
  `mcpServers.<name>.tools`, but matched against the full
  `mcp__<server>__<tool>` name across all servers. `include` empty = all
  tools; `exclude` always wins. Explicit allowlists beat any heuristic.
- `limits.mcpSchemaTokens` (default `0` = off) — ceiling for the total schema
  of advertised MCP tools. Tools are kept in config order until the budget is
  spent; the rest are simply not advertised and the agent warns once with the
  dropped count. The local model profile turns this on at 6000.

Measured with the cap at 6000: 53 advertised tools → 24, MCP schema 13,977 →
~6,300 tokens per call.

Callers may also request a per-agent tool subset (`tools` in an agent
definition). That filter runs on the **builtin** tools only — MCP tools are
governed by the three levers above, and `mcp__…` names written in an agent's
`tools` list are simply not matched (they stay advertised unless a filter
removes them).

## MCP Resources & Prompts

Connected servers may expose resources and prompts (Phase 4). The agent has
generic tools `mcp_list_resources`, `mcp_read_resource` (optional `subscribe`),
`mcp_list_prompts`, and `mcp_get_prompt`, advertised only when a server
supports them. Notifications (`resources/list_changed`, `prompts/list_changed`,
`resources/updated`, `progress`) refresh caches automatically.

## CLI Management

```bash
scoder mcp list
scoder mcp add <name> --command "..." [--url "..."] [--trust auto|ask|readonly|deny] [--args "..."]
scoder mcp remove <name>
scoder mcp test <name>
scoder mcp import [path] [--dry-run] [--force]
```

`scoder mcp import` discovers and imports server definitions from Claude Desktop
(`~/.claude.json`), OpenCode (`opencode.json`), and `.mcp.json`.

## Security

- MCP tools bypass the built-in shell permission system; in `readonly` mode they
  are disabled entirely.
- Tool output is flagged `untrusted: true` in the event stream and wrapped with
  an `[UNTRUSTED]` marker in the LLM conversation.
- Audit log entries (`mcp_audit`) are written to the JSONL log for MCP tool
  calls and resource reads.