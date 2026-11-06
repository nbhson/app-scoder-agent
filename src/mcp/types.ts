export interface McpServerConfig {
  /** stdio: command to spawn (mặc định khi không có url). */
  command?: string;
  args?: string[];
  /** Supports {env:VAR} substitution — never hardcode secrets in config */
  env?: Record<string, string>;
  /** M3: HTTP transport — URL của MCP endpoint (Streamable HTTP). */
  url?: string;
  /** M3: headers cho HTTP transport (auth token qua {env:VAR} substitution). */
  headers?: Record<string, string>;
  /** M3: override loại transport; mặc định suy ra từ url/command. */
  type?: "stdio" | "http";
  /** MCP A: per-server tool governance — include/exclude filters. */
  tools?: { include?: string[]; exclude?: string[] };
  /** MCP A: request timeout (ms) — override default 120s. */
  timeoutMs?: number;
  /** MCP B: whether to connect this server at all (default true). */
  enabled?: boolean;
  /** MCP B: permission mode for this server's tools. Defaults to "auto" (use global mode). */
  trust?: "auto" | "ask" | "readonly" | "deny";
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** MCP resources (Phase 4) — read-only data a server exposes by URI. */
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri?: string;
  mimeType?: string;
  text?: string;
  /** base64 payload for binary resources (never sent to the LLM verbatim). */
  blob?: string;
}

/** MCP prompts (Phase 4) — server-provided prompt templates. */
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
  role?: string;
  content?: unknown;
}

export const MCP_TOOL_PREFIX = "mcp__";

export function mcpToolKey(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

/** Phase 4: generic MCP resource/prompt tools (advertised only when available). */
export const MCP_RESOURCE_TOOL_NAMES = new Set([
  "mcp_list_resources",
  "mcp_read_resource",
  "mcp_list_prompts",
  "mcp_get_prompt",
]);

export type McpConnState = "connecting" | "ready" | "reconnecting" | "dead" | "disabled";

// ── Transport abstraction (M3) ───────────────────────────────────────────────

/** A JSON-RPC message channel to one MCP server. */
export interface McpTransport {
  readonly kind: "stdio" | "http";
  /** Channel usable for send()? */
  readonly alive: boolean;
  /** Establish the channel (spawn process / reset session state). */
  start(): Promise<void>;
  /** Send one JSON-RPC message. HTTP: resolves khi response đã được parse. */
  send(msg: object): Promise<void>;
  /** Inbound JSON-RPC messages (responses + server notifications). */
  onMessage(cb: (msg: Record<string, unknown>) => void): void;
  /** Channel died irrecoverably (process exit). HTTP: không dùng (stateless). */
  onDown(cb: (err: Error) => void): void;
  close(): void;
}
