/**
 * I-12 eval scenarios — guardrails + finish rules.
 * Mỗi scenario: { name, task?, buildCmd?, maxSteps?, guardrails?, script, check }.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});

export default {
  name: "doom-loop caught",
  maxSteps: 10,
  guardrails: { doomLoopRepeats: 2 },
  script: [
    // 3 step giống hệt nhau → sigRepeat vượt ngưỡng
    { toolCalls: [tc("d1", "read_file", { path: "a.ts" })] },
    { toolCalls: [tc("d2", "read_file", { path: "a.ts" })] },
    { toolCalls: [tc("d3", "read_file", { path: "a.ts" })] },
    { toolCalls: [tc("d4", "read_file", { path: "a.ts" })] },
  ],
  check({ events, result }) {
    const g = events.filter((e) => e.type === "guardrail" && e.rule === "doom-loop");
    if (g.length === 0) throw new Error("doom-loop guardrail not fired");
    if (result.success === true && result.steps > 8) throw new Error("should stop early via doom-loop");
  },
};
