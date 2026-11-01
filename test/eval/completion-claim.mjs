/**
 * I-12 eval — completion-claim → verify-build: model modified files, claims
 * done; build fails first time → reminder inject, model fixes, build passes.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default {
  name: "completion-claim forces build verify",
  buildCmd: "node build.js",
  maxSteps: 10,
  script: [
    // Claim ngay khi chưa sửa gì có mul? — Không: claim "complete" sau khi edit
    // add (filesModified=true) nhưng build fail (mul thiếu).
    { toolCalls: [tc("v0", "write_file", { path: "note.txt", content: "start" })] },
    { content: "The task is now complete." },
    { toolCalls: [tc("v2", "edit_file", { path: "lib.js", old_string: "a + b;", new_string: "a + b; module.exports.mul = (a,b) => a*b;" })] },
    { content: "All done — task is complete." },
  ],
  setup(workdir) {
    // lib.js có add đúng sẵn nhưng THIẾU mul → build fail lần 1; edit 1 thêm
    // mul → build pass. Claims "task complete" sau edit 1 → verify fail →
    // reminder; sau edit 2 → verify pass.
    writeFileSync(join(workdir, "lib.js"), "module.exports.add = (a, b) => a + b;\n");
    writeFileSync(
      join(workdir, "build.js"),
      "const lib = require('./lib.js');\nif (!lib.mul || lib.mul(2, 3) !== 6) { console.error('FAIL: mul missing/wrong'); process.exit(1); }\nconsole.log('PASS');\n",
    );
  },
  check({ events, result }) {
    // Lần claim đầu → build fail → reminder; lần 2 → pass.
    const buildEvents = events.filter((e) => e.type === "build");
    if (buildEvents.length < 2) throw new Error(`expected ≥2 build runs, got ${buildEvents.length}`);
    if (buildEvents[0].success !== false) throw new Error("first build should fail");
    if (result.success !== true) throw new Error(`run should succeed, got: ${result.summary}`);
  },
};
