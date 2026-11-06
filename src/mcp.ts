/**
 * Legacy public path — compatibility facade for the MCP client.
 * Implementations live under src/mcp/.
 */
export * from "./mcp/types.js";
export * from "./mcp/env.js";
export * from "./mcp/sse.js";
export * from "./mcp/transport-stdio.js";
export * from "./mcp/transport-http.js";
export * from "./mcp/connection.js";
export * from "./mcp/manager.js";
