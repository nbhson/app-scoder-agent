/**
 * I-12 eval — text-only streak guardrail: model trả lời suốt không làm gì.
 */
export default {
  name: "text-only-streak injects reminder",
  maxSteps: 10,
  guardrails: { textOnlyStreakLimit: 3 },
  script: [
    { content: "Let me think about this task." },
    { content: "Still analyzing." },
    { content: "More thinking..." },
    { content: "Hmm." },
  ],
  check({ events }) {
    const g = events.filter((e) => e.type === "guardrail" && e.rule === "text-only-streak");
    if (g.length === 0) throw new Error("text-only-streak guardrail not fired");
  },
};
