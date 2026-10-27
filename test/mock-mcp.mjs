// Minimal mock MCP stdio server for testing.
// Speaks newline-delimited JSON-RPC 2.0: initialize, tools/list, tools/call.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification — no response

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "0.1.0" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo back a message",
            inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    const args = msg.params?.arguments ?? {};
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: `ECHO: ${args.message ?? ""}` }], isError: false },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
});

// keep the process alive
setInterval(() => {}, 60_000);
