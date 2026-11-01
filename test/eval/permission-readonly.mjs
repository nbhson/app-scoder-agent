/**
 * I-12 eval — readonly mode: mutating tool calls bị chặn, read-only chạy ok.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});

export default {
  name: "permission matrix — readonly blocks mutations",
  permissionMode: "readonly",
  maxSteps: 6,
  async setup(workdir) {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(workdir, "package.json"), "{}\n");
  },
  script: [
    { toolCalls: [tc("p1", "write_file", { path: "x.txt", content: "nope" })] },
    { toolCalls: [tc("p2", "read_file", { path: "package.json" })] },
  ],
  check({ events }) {
    const wr = events.find((e) => e.type === "tool_result" && e.name === "write_file");
    if (!wr || wr.ok !== false) throw new Error("write_file should be blocked in readonly");
    if (!/readonly/i.test(wr.output)) throw new Error(`write_file error should mention readonly: ${wr.output}`);
    const rd = events.find((e) => e.type === "tool_result" && e.name === "read_file");
    if (!rd || rd.ok !== true) throw new Error(`read_file should pass in readonly: ${rd?.output}`);
  },
};
