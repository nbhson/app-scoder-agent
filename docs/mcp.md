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