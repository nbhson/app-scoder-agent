# P1.1 — MCP Client Support

## Mục tiêu

Agent có thể dùng tool từ MCP (Model Context Protocol) servers — tiêu chuẩn mở rộng công cụ của ngành (OpenCode, Cline, Claude Code đều hỗ trợ).

## Phạm vi phase này

- **Chỉ stdio MCP servers** (process con, giao tiếp qua stdin/stdout) — đơn giản, không cần network
- HTTP/SSE MCP servers → để sau (P2)

## Thiết kế

### 1. Config

```jsonc
// .coderrc.json
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
    }
  }
}
```

`{env:VAR}` substitution — không viết secret thẳng vào config.

### 2. MCP client (JSON-RPC 2.0 over stdio)

File mới `src/mcp.ts`:

- `McpServerConnection`: spawn process, gửi JSON-RPC qua stdin, đọc stdout line-by-line
- Handshake: `initialize` → `tools/list` → giữ connection mở
- `callTool(name, args)`: gửi `tools/call`, chờ response (matching `id`), timeout
- Parse kết quả: `content: [{type:"text", text}]` → string output

JSON-RPC messages:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"coder","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"..."}}}
```

### 3. Tích hợp vào tool registry

- Khi Agent khởi tạo: connect các MCP server (parallel, timeout 10s mỗi server), lấy tools/list
- Convert MCP tool schema → `ToolSpec` OpenAI format:
  ```
  MCP: {name, description, inputSchema} → {type:"function", function:{name:"mcp__<server>__<tool>", description, parameters: inputSchema}}
  ```
  Prefix `mcp__<server>__` tránh trùng tên với built-in tools
- Khi agent gọi tool tên bắt đầu `mcp__` → route tới MCP server tương ứng qua `tools/call`
- Tool result MCP: `{content:[{type:"text",text}], isError}` → map sang `ToolResult`

### 4. Vòng đời

- Connect lazily khi agent start; disconnect (kill process) khi agent run kết thúc
- Server crash giữa chừng → tool call trả lỗi cho LLM, không crash agent
- Name collision giữa các server → reject config khi load (lỗi rõ ràng)

## File changes

| File | Thay đổi |
|---|---|
| `src/mcp/client.ts` | **NEW** — JSON-RPC over stdio client, tool discovery + call |
| `src/mcp/types.ts` | **NEW** — MCP protocol types |
| `src/tools.ts` | Registry chấp nhận tool từ nguồn ngoài (merge MCP tools) |
| `src/agent.ts` | Connect MCP servers lúc start, route tool calls |
| `src/config.ts` | Parse `mcpServers` từ rc + env |

## Acceptance criteria

1. Config 1 stdio MCP server (ví dụ filesystem server) → tools của nó xuất hiện trong tool list của LLM
2. LLM gọi MCP tool → kết quả trả về đúng
3. MCP server không khởi động được → warning, agent vẫn chạy với built-in tools
4. Không thêm runtime dependencies (tự viết JSON-RPC client ~150 dòng)
5. E2E: mock MCP server (node script) trong test/, verify tool discovery + call
