/**
 * I-12 eval — steering: user steer() giữa run được deliver ở step boundary.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});

export default {
  name: "steering delivered at step boundary",
  maxSteps: 8,
  script: [
    { toolCalls: [tc("s1", "list_files", {})] },
    { toolCalls: [tc("s2", "list_files", {})] },
    { content: "ok " + "x" },
  ],
  async drive(agent) {
    // Steer sau step đầu (event-driven — khi thấy tool_call đầu tiên).
    await new Promise((resolve) => {
      const orig = agent.onEvent;
      agent.onEvent = (ev) => {
        orig?.(ev);
        if (ev.type === "step" && ev.step >= 2) {
          agent.steer("Also rename the file to b.ts");
          agent.onEvent = orig;
          resolve();
        }
      };
    });
  },
  check({ events }) {
    const delivered = events.filter((e) => e.type === "steer_delivered");
    if (delivered.length === 0) throw new Error("steer_delivered not emitted");
    if (delivered[0].count < 1) throw new Error("steer batch empty");
  },
};
