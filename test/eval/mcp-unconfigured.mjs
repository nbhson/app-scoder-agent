/**
 * I-12 eval — MCP hygiene: calling an MCP tool on a server that is not
 * configured fails cleanly as a tool_result (ok:false), never crashes the run.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});

export default {
  name: "unconfigured MCP tool call fails cleanly",
  maxSteps: 6,
  script: [
    { toolCalls: [tc("m1", "mcp__nope__nope", {})] },
    { content: "MCP unavailable — answering without it." },
  ],
  check({ events }) {
    const r = events.find((e) => e.type === "tool_result" && e.name === "mcp__nope__nope");
    if (!r) throw new Error("no tool_result for mcp__nope__nope");
    if (r.ok !== false) throw new Error("unconfigured MCP tool must fail, not succeed");
  },
};
