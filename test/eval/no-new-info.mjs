/**
 * Eval — loop NGUY HIỂM NHẤT: model fetch/đọc LIÊN TỤC nhưng mỗi lệnh một args
 * KHÁC NHAU (URL đếm dần angular-22-1, -2, … trong log thật
 * ~/.scoder/sessions/20261126-141619-e507) nên streak/cycle/scattered đều im
 * lặng — trong khi mọi output là CÙNG một nội dung. no-new-information đo
 * thông tin, không đo lệnh: run phải bị cắt và summary nói rõ lý do.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** 6 dòng ≥12 ký tự — y hệt trong cả 8 file ("cùng một trang web"). */
const PAGE = [
  "Release v22 introduces fine-grained signals with automatic dependency tracking.",
  "Control flow templates use the new syntax for conditionals and iteration blocks.",
  "Deferrable views load sections of the template on demand for smaller bundles.",
  "Zoneless change detection removes the requirement for zone.js in new apps.",
  "Injection tokens now support async factories with typed provider definitions.",
  "The migration guide covers every breaking change listed in the changelog below.",
].join("\n");

export default {
  name: "content-repeat loop is caught by no-new-information",
  maxSteps: 20,
  guardrails: { doomLoopRepeats: 2 },
  script: Array.from({ length: 12 }, (_, i) => ({
    toolCalls: [tc(`r${i}`, "read_file", { path: `doc${i + 1}.txt` })],
  })),
  setup(workdir) {
    for (let i = 1; i <= 12; i++) writeFileSync(join(workdir, `doc${i}.txt`), PAGE + `\n(file ${i})`);
  },
  check({ events, result }) {
    const fired = events.filter((e) => e.type === "guardrail" && e.rule === "no-new-information");
    if (fired.length === 0) throw new Error("no-new-information guardrail không phát hiện lặp nội dung");
    if (!fired.some((e) => e.action === "inject")) throw new Error("phải inject nhắc trước khi dừng");
    if (!fired.some((e) => e.action === "finish")) throw new Error("phải finish khi model vẫn tiếp tục");
    if (result.steps > 8) throw new Error(`run nên dừng sớm, thực tế ${result.steps} steps`);
    if (!/same information|new content/i.test(result.summary ?? "")) {
      throw new Error(`summary phải nói rõ vì sao dừng: ${result.summary}`);
    }
  },
};
