/**
 * I-12 eval — error recovery: first tool call fails (missing file), the
 * agent recovers by reading the right path and finishes. Exercises the
 * tool_result ok:false → retry path.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default {
  name: "error recovery — failed read, retry, finish",
  maxSteps: 8,
  script: [
    { toolCalls: [tc("e1", "read_file", { path: "does-not-exist.ts" })] },
    { toolCalls: [tc("e2", "read_file", { path: "real.ts" })] },
    { content: "Found the file — done." },
  ],
  setup(workdir) {
    writeFileSync(join(workdir, "real.ts"), "export const answer = 42;\n");
  },
  check({ events, result }) {
    const results = events.filter((e) => e.type === "tool_result" && e.name === "read_file");
    if (results.length < 2) throw new Error(`expected ≥2 read_file results, got ${results.length}`);
    if (results[0].ok !== false) throw new Error("first read_file should fail");
    if (results[1].ok !== true) throw new Error("second read_file should succeed");
    if (result.success !== true) throw new Error(`run should succeed, got: ${result.summary}`);
  },
};
