/**
 * I-12 eval — task subagent: parent chạy task tool → child (scripted) trả
 * summary; event relay xuất hiện dưới tool_output subagent-tagged.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});

export default {
  name: "subagent task relay",
  maxSteps: 8,
  script: [
    {
      toolCalls: [
        tc("t1", "task", { description: "find auth", prompt: "Where is auth code?", agent: "explore" }),
      ],
    },
    { content: "explore done" },
  ],
  check({ events }) {
    const relay = events.filter((e) => e.type === "tool_output" && e.name?.startsWith("subagent:"));
    if (relay.length === 0) throw new Error("no subagent:<name> relay events");
    const r = events.find((e) => e.type === "tool_result" && e.name === "task");
    if (!r || r.ok !== true) throw new Error(`task tool should succeed: ${r?.output}`);
    if (!/subagent explore done/.test(r.output)) throw new Error(`missing subagent summary: ${r.output.slice(0, 200)}`);
  },
};
