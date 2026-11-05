/**
 * I-12 eval — happy path: write a file, build passes, run succeeds.
 * Also pins the v2 event schema: run_start.schemaVersion, context event,
 * finish.usage + finish.verification.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default {
  name: "happy path — build passes, v2 events present",
  buildCmd: "node build.js",
  maxSteps: 8,
  script: [
    { toolCalls: [tc("h1", "write_file", { path: "out.txt", content: "hello" })] },
    { content: "Done — task is complete." },
  ],
  setup(workdir) {
    writeFileSync(join(workdir, "build.js"), "console.log('PASS');\n");
  },
  check({ events, result }) {
    const rs = events.find((e) => e.type === "run_start");
    if (!rs) throw new Error("run_start missing");
    if (rs.schemaVersion !== 2) throw new Error(`run_start.schemaVersion should be 2, got ${rs.schemaVersion}`);
    const ctx = events.find((e) => e.type === "context");
    if (!ctx) throw new Error("context event not emitted after LLM turn");
    const build = events.find((e) => e.type === "build");
    if (!build || build.success !== true) throw new Error("expected a passing build event");
    if (result.success !== true) throw new Error(`run should succeed, got: ${result.summary}`);
    const fin = events.find((e) => e.type === "finish");
    if (!fin) throw new Error("finish event missing");
    if (!fin.usage || typeof fin.usage.inputTokens !== "number") throw new Error("finish.usage missing/invalid");
    if (!fin.verification || fin.verification.ok !== true) throw new Error(`finish.verification should be ok:true, got ${JSON.stringify(fin.verification)}`);
  },
};
