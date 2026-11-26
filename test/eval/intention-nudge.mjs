/**
 * Eval — "Tôi sẽ tìm …" rồi im lặng (log thật session 20261126-141447-93ef:
 * run kết thúc steps=1 success=true với chính câu hứa làm summary ⇒ user không
 * thấy kết quả). continue-nudge phải phân biệt LỜI HỨA HÀNH ĐỘNG với câu trả
 * lời chat: inject nhắc gọi tool, run đi tiếp tới khi có dữ liệu thật.
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default {
  name: "announced intention is nudged, not finished",
  maxSteps: 10,
  script: [
    { content: "Để tôi tìm và đọc file config rồi tổng hợp lại các mục quan trọng nhất cho bạn." },
    { toolCalls: [tc("c1", "read_file", { path: "config.json" })] },
    {
      content:
        "Đây là kết quả: project dùng hai biến environment chính là API_URL trỏ tới gateway nội bộ " +
        "và LOG_LEVEL đặt ở mức debug cho môi trường staging.",
    },
  ],
  setup(workdir) {
    writeFileSync(join(workdir, "config.json"), JSON.stringify({ API_URL: "http://gw", LOG_LEVEL: "debug" }, null, 2));
  },
  check({ events, result }) {
    const nudge = events.find((e) => e.type === "guardrail" && e.rule === "continue-nudge");
    if (!nudge) throw new Error("continue-nudge không fire trước lời hứa hành động");
    if (nudge.action !== "inject") throw new Error(`lời hứa phải bị inject nhắc, actual=${nudge.action}`);
    if (!/intention/i.test(nudge.reason)) throw new Error(`reason phải nêu intention: ${nudge.reason}`);
    const read = events.find((e) => e.type === "tool_result" && e.name === "read_file");
    if (!read) throw new Error("run phải đi tiếp tới bước đọc file thay vì dừng ở step 1");
    if (!/API_URL/.test(result.summary ?? "")) {
      throw new Error(`summary phải là kết quả thật: ${JSON.stringify((result.summary ?? "").slice(0, 120))}`);
    }
  },
};
