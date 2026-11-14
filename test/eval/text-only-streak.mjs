/**
 * I-12 eval — text-only streak guardrail: model chỉ nói không làm TRONG LÚC
 * plan còn mở (nghiệp giữa task) → nudge vài bước, tới ngưỡng streak thì
 * dừng run. (P0-8 đổi semantics: text-only khi CHƯA sửa file & plan trống
 * là lượt chat — finish 1 LLM call, test ở chat-turn.mjs; streak rule chỉ
 * bắt được stall trên đường đang làm việc, như comment trong
 * continueNudgeRule vẫn ghi: "text-only-streak still ends the run if it
 * keeps stalling".)
 */
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
});

export default {
  name: "text-only-streak ends a stalling run",
  maxSteps: 12,
  guardrails: { textOnlyStreakLimit: 3 },
  script: [
    // Plan mở (còn in_progress/pending) ⇒ các bước text-only là stall, không
    // phải lượt chat → continue-nudge inject; streak đếm tới 3 → finish.
    {
      toolCalls: [
        tc("p1", "write_todos", {
          todos: [
            { content: "implement fix", status: "in_progress" },
            { content: "verify", status: "pending" },
          ],
        }),
      ],
    },
    { content: "Let me think about this task." },
    { content: "Still analyzing." },
    { content: "More thinking..." },
    { content: "Hmm." },
  ],
  check({ events }) {
    const g = events.filter((e) => e.type === "guardrail" && e.rule === "text-only-streak");
    if (g.length === 0) throw new Error("text-only-streak guardrail not fired");
    if (g[0].action !== "finish") throw new Error(`expected finish action, got ${g[0].action}`);
    // Streak phải đếm đủ ngưỡng trước khi fire (step 2..4 nudge, step 5 fire).
    const nudges = events.filter((e) => e.type === "guardrail" && e.rule === "continue-nudge");
    if (nudges.length < 3) throw new Error(`expected ≥3 nudges before streak fired, got ${nudges.length}`);
  },
};
