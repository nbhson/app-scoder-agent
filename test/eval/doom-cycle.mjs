/**
 * Eval — doom-loop dạng CHU KỲ (không phải batch giống hệt liên tiếp).
 *
 * Mô phỏng model local hay lặp: đọc file → grep → đọc lại đúng file đó → grep
 * lại đúng pattern đó… Detector cũ bỏ lọt toàn bộ vì mỗi batch khác batch liền
 * trước. Kịch bản này chứng minh: loop bị phát hiện, run kết thúc sớm, và lệnh
 * đọc trùng không bị chạy lại lần hai (cache).
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const READ_A = { path: "a.ts" };
const GREP_FOO = { pattern: "foo", path: "." };

export default {
  name: "cyclic tool-call loop is caught",
  maxSteps: 20,
  guardrails: { doomLoopRepeats: 2 },
  script: [
    { toolCalls: [tc("s1", "read_file", READ_A)] },
    { toolCalls: [tc("s2", "grep", { ...GREP_FOO }, )] },
    // JSON lệch whitespace/thứ tự key — vẫn phải bị coi là lặp.
    { toolCalls: [tc("s3", "read_file", '{ "path" : "a.ts" }')] },
    { toolCalls: [tc("s4", "grep", '{ "path": ".", "pattern": "foo" }')] },
    { toolCalls: [tc("s5", "read_file", READ_A)] },
    { toolCalls: [tc("s6", "grep", GREP_FOO)] },
    { toolCalls: [tc("s7", "read_file", READ_A)] },
    { toolCalls: [tc("s8", "grep", GREP_FOO)] },
    { toolCalls: [tc("s9", "read_file", READ_A)] },
    { toolCalls: [tc("s10", "grep", GREP_FOO)] },
  ],
  setup(workdir) {
    writeFileSync(join(workdir, "a.ts"), "export const foo = 1;\n");
    mkdirSync(join(workdir, "src"), { recursive: true });
  },
  check({ events, result }) {
    const fired = events.filter((e) => e.type === "guardrail" && e.rule === "doom-loop");
    if (fired.length === 0) throw new Error("doom-loop guardrail không phát hiện cycle lặp");
    if (!fired.some((e) => /period/.test(e.reason))) {
      throw new Error(`expected a cycle reason, got: ${fired.map((e) => e.reason).join(" | ")}`);
    }
    // Loop phải bị cắt jauh trước budget 20 step.
    if (result.steps > 8) throw new Error(`run nên dừng sớm, thực tế ${result.steps} steps`);
    if (result.success !== false) throw new Error("loop không hoàn thành việc — result phải failure");
    if (!/loop/i.test(result.summary ?? "")) {
      throw new Error(`summary phải nói rõ vì sao dừng: ${result.summary}`);
    }
    const cached = events.filter((e) => e.type === "tool_result" && e.cached === true);
    if (cached.length === 0) throw new Error("lệnh đọc trùng args phải được phục vụ từ cache, không chạy lại");
  },
};
