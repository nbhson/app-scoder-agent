// MCP smoke test: connect to the mock MCP stdio server, discover tools, call one.
import { McpManager } from "../dist/mcp.js";

const manager = new McpManager({
  mock: { command: "node", args: [new URL("./mock-mcp.mjs", import.meta.url).pathname] },
});

let failed = false;
try {
  const count = await manager.connectAll();
  if (count !== 1) throw new Error(`expected 1 MCP tool, got ${count}`);

  const key = "mcp__mock__echo";
  if (!manager.hasTool(key)) throw new Error(`tool ${key} not registered`);

  const specs = manager.toToolSpecs();
  if (specs.length !== 1 || specs[0].function.name !== key) {
    throw new Error("tool spec conversion failed");
  }

  const reg = manager.getTool(key);
  const res = await reg.conn.callTool("echo", { message: "hello mcp" });
  if (!res.ok || res.output !== "ECHO: hello mcp") {
    throw new Error(`callTool failed: ok=${res.ok} output=${JSON.stringify(res.output)}`);
  }

  console.log("\n✅ MCP SMOKE TEST PASSED: connect + tools/list + tools/call");
} catch (err) {
  console.error(`\n❌ MCP SMOKE TEST FAILED: ${err.message}`);
  failed = true;
} finally {
  manager.killAll();
}
process.exit(failed ? 1 : 0);
