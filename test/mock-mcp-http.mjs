// M3: Minimal mock MCP HTTP (Streamable HTTP) server for testing.
// POST JSON-RPC; initialize → SSE response + Mcp-Session-Id; còn lại → JSON.
import { createServer } from "node:http";

const sessions = new Set();

export function startMockMcpHttp(port = 0) {
  const seen = { sessionEchoed: 0, authHeader: null };
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    seen.authHeader = req.headers.authorization ?? null;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (req.headers["mcp-session-id"]) seen.sessionEchoed++;

      // Notification (không id) → 202 Accepted, không body (MCP spec).
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }

      const replyJson = (result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };

      if (msg.method === "initialize") {
        const sid = "sess-" + (sessions.size + 1);
        sessions.add(sid);
        // SSE stream response — kiểm tra parse SSE phía client.
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": sid,
        });
        res.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "mock-mcp-http", version: "0.1.0" },
            },
          })}\n\n`,
        );
        return;
      }
      if (msg.method === "tools/list") {
        replyJson({
          tools: [
            {
              name: "echo",
              description: "Echo back a message",
              inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
            },
          ],
        });
        return;
      }
      if (msg.method === "tools/call") {
        const args = msg.params?.arguments ?? {};
        replyJson({ content: [{ type: "text", text: `ECHO: ${args.message ?? ""}` }] });
        return;
      }
      res.writeHead(400).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, seen, url: `http://127.0.0.1:${addr.port}/mcp` });
    });
  });
}
