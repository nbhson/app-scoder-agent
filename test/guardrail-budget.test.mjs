/**
 * G6: guardrail async rule + token budget rule.
 * Chạy: node --test test/guardrail-budget.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenBudgetRule, createGuardrailEngine } from "../dist/guardrails.js";

const baseCtx = {
  step: 1,
  maxSteps: 20,
  text: "working",
  message: null,
  hasToolCalls: false,
  buildPassedThisStep: false,
  buildCallPresent: false,
  filesModified: false,
  chatDone: false,
};

describe("tokenBudgetRule (G6)", () => {
  it("dưới cap → null", () => {
    const rule = tokenBudgetRule(1000);
    assert.equal(rule.evaluate({ ...baseCtx, totalTokensIn: 400, totalTokensOut: 500 }), null);
  });

  it("đạt cap → finish (không success)", () => {
    const rule = tokenBudgetRule(1000);
    const d = rule.evaluate({ ...baseCtx, totalTokensIn: 900, totalTokensOut: 200 });
    assert.ok(d);
    assert.equal(d.action.kind, "finish");
    assert.equal(d.action.success, false);
    assert.match(d.reason, /token budget/);
  });
});

describe("async rule (G6)", () => {
  it("engine await rule async — Promise trả decision", async () => {
    const eng = createGuardrailEngine();
    eng.register({
      name: "async-probe",
      description: "test async",
      async evaluate() {
        return { action: { kind: "inject", reminder: "async works" }, reason: "async rule fired" };
      },
    });
    const ds = await eng.evaluate(baseCtx);
    assert.ok(ds.some((d) => d.rule === "async-probe" && d.action.kind === "inject"));
  });

  it("async rule throw → decision none, không gãy engine", async () => {
    const eng = createGuardrailEngine();
    eng.register({
      name: "async-boom",
      description: "test throw",
      evaluate: async () => {
        throw new Error("async boom");
      },
    });
    const ds = await eng.evaluate(baseCtx);
    const d = ds.find((x) => x.rule === "async-boom");
    assert.ok(d);
    assert.equal(d.action.kind, "none");
  });

  it("rc guardrails.tokenBudget → engine chứa token-budget rule", () => {
    const eng = createGuardrailEngine({ tokenBudget: 5000 });
    assert.ok(eng.listRules().some((r) => r.name === "token-budget"));
    const eng2 = createGuardrailEngine({});
    assert.ok(!eng2.listRules().some((r) => r.name === "token-budget"));
  });
});
