/**
 * P0-8 eval — lượt chat: text-only, chưa sửa file, plan trống ⇒ finish NGAY
 * bằng chính câu trả lời (1 LLM call/message — không đốt thêm ~14,5k token
 * cho một dòng nudge vô sản). Đây là semantics thay cho vòng "nudge" cũ mà
 * text-only-streak.mjs từng kiểm tra.
 */
export default {
  name: "chat turn finishes after one LLM call",
  maxSteps: 12,
  script: [{ content: "Xin chao! To co the giup gi?" }],
  check({ events, result }) {
    const g = events.filter((e) => e.type === "guardrail" && e.rule === "continue-nudge");
    if (g.length !== 1 || g[0].action !== "finish") {
      throw new Error(`expected a single chat-turn finish decision, got ${JSON.stringify(g.map((d) => d.action))}`);
    }
    if (!/chat turn/.test(g[0].reason)) throw new Error(`unexpected reason: ${g[0].reason}`);
    if (result.steps !== 1) throw new Error(`chat turn must end in 1 step, took ${result.steps}`);
    const finish = events.find((e) => e.type === "finish");
    if (!finish || finish.success !== true) throw new Error("chat turn must finish successfully");
  },
};
