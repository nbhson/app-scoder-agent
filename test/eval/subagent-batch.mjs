/**
 * I-12 eval — task batch: parent gọi task với tasks[] → 2 subagent chạy song
 * song (bounded), mỗi child emit agent_start/agent_end, kết quả merge theo
 * đúng thứ tự task.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});

export default {
  name: "subagent task batch",
  maxSteps: 10,
  script: [
    {
      toolCalls: [
        tc("t1", "task", {
          tasks: [
            { description: "map auth", prompt: "Where is auth code?", agent: "explore" },
            { description: "map billing", prompt: "Where is billing code?", agent: "explore" },
          ],
        }),
      ],
    },
    { content: "batch done" },
  ],
  check({ events }) {
    const starts = events.filter((e) => e.type === "agent_start");
    if (starts.length !== 2) throw new Error(`expected 2 agent_start events, got ${starts.length}`);
    const ends = events.filter((e) => e.type === "agent_end");
    if (ends.length !== 2) throw new Error(`expected 2 agent_end events, got ${ends.length}`);

    const r = events.find((e) => e.type === "tool_result" && e.name === "task");
    if (!r || r.ok !== true) throw new Error(`task batch should succeed: ${r?.output}`);
    if (!/\[batch 2 tasks — 2\/2 ok\]/.test(r.output)) {
      throw new Error(`missing batch header: ${r.output.slice(0, 300)}`);
    }
    // Merge must preserve task order, not completion order.
    if (!/Task 1: map auth[\s\S]*Task 2: map billing/.test(r.output)) {
      throw new Error(`missing ordered per-task sections: ${r.output.slice(0, 400)}`);
    }
  },
};
