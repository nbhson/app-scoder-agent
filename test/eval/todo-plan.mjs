/**
 * I-12 eval — planning: write_todos emits a todo event whose items carry
 * content + status; completing the plan clears in_progress.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});

export default {
  name: "write_todos emits ordered plan items",
  maxSteps: 8,
  script: [
    {
      toolCalls: [
        tc("p1", "write_todos", {
          todos: [
            { content: "investigate", status: "completed" },
            { content: "implement fix", status: "in_progress" },
            { content: "verify", status: "pending" },
          ],
        }),
      ],
    },
    { content: "plan noted" },
  ],
  check({ events }) {
    const todos = events.filter((e) => e.type === "todo");
    if (todos.length === 0) throw new Error("no todo event emitted");
    const items = todos[todos.length - 1].items;
    if (items.length !== 3) throw new Error(`expected 3 todos, got ${items.length}`);
    const inProgress = items.filter((t) => t.status === "in_progress");
    if (inProgress.length !== 1) throw new Error(`expected exactly 1 in_progress, got ${inProgress.length}`);
  },
};
