// Minimal mock MCP stdio server for testing.
// Speaks newline-delimited JSON-RPC 2.0: initialize, tools, resources, prompts.
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
        capabilities: {
          tools: {},
          ping: true,
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
        },
        serverInfo: { name: "mock-mcp", version: "0.1.0" },
      },
    });
    return;
  }
  if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
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
    // Exercise the progress-notification path (Phase 4).
    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1, total: 1, message: "done" } });
    return;
  }
  if (msg.method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        resources: [
          { uri: "mock://readme", name: "README", description: "Mock readme", mimeType: "text/plain" },
        ],
      },
    });
    return;
  }
  if (msg.method === "resources/templates/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        resourceTemplates: [
          { uriTemplate: "mock://items/{id}", name: "Item", description: "Mock item" },
        ],
      },
    });
    return;
  }
  if (msg.method === "resources/read") {
    const uri = msg.params?.uri ?? "";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { contents: [{ uri, mimeType: "text/plain", text: `RESOURCE: ${uri}` }] },
    });
    return;
  }
  if (msg.method === "resources/subscribe") {
    const uri = msg.params?.uri ?? "";
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    // Simulate the server pushing an update right after subscription.
    send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
    return;
  }
  if (msg.method === "resources/unsubscribe") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "prompts/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        prompts: [
          {
            name: "greet",
            description: "Greeting prompt",
            arguments: [{ name: "name", description: "Who to greet", required: true }],
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "prompts/get") {
    const args = msg.params?.arguments ?? {};
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        description: "Greeting prompt",
        messages: [{ role: "user", content: { type: "text", text: `Hello ${args.name ?? "world"}` } }],
      },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
});

// keep the process alive
setInterval(() => {}, 60_000);
