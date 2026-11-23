/**
 * P2.2 Phase B (plan/P2-02 §2) — live turn sensors. The Agent already emits
 * the whole event stream; instead of parallel bookkeeping we *listen* to it:
 * step → step counter, tool_call → phase, build → fail streak, tool_result
 * invalid-JSON → arg-repair streak, guardrail → doom-loop streak.
 *
 * The tracked event shape is intentionally structural (`TrackableEvent`) so
 * this module imports nothing from src/agent (layer-clean for the router).
 */
import { IDLE_TURN_CONTEXT, type TurnContext } from "./types.js";
import { phaseFromToolCall } from "./classifier.js";

export interface TrackableEvent {
  type: string;
  step?: number;
  maxSteps?: number;
  name?: string;
  ok?: boolean;
  success?: boolean;
  output?: string;
}

/** Guardrail trips are only "consecutive" while nothing succeeded since. */
const GUARDRAIL_DECAY_STEPS = 5;

export class TurnSensors {
  private ctx: TurnContext = { ...IDLE_TURN_CONTEXT };
  private lastGuardrailStep = -1;

  context(): TurnContext {
    return { ...this.ctx };
  }

  /** Reset between runs (Agent.run start) — a stale build streak must not
   *  escalate turn 1 of the next task. */
  reset(maxSteps: number): void {
    this.ctx = { ...IDLE_TURN_CONTEXT, maxSteps };
    this.lastGuardrailStep = -1;
  }

  track(ev: TrackableEvent): void {
    switch (ev.type) {
      case "step":
        this.ctx.step = ev.step ?? this.ctx.step;
        if (typeof ev.maxSteps === "number") this.ctx.maxSteps = ev.maxSteps;
        this.decayGuardrail();
        break;
      case "tool_call": {
        const p = phaseFromToolCall(ev.name);
        if (p) this.ctx.phase = p;
        break;
      }
      case "tool_result":
        if (ev.ok === true) {
          this.ctx.toolArgsRepairStreak = 0;
          this.ctx.guardrailStreak = 0;
        } else if (typeof ev.output === "string" && ev.output.includes("invalid JSON arguments")) {
          this.ctx.toolArgsRepairStreak += 1;
        }
        break;
      case "build":
        this.ctx.buildFailStreak = ev.success ? 0 : this.ctx.buildFailStreak + 1;
        if (ev.success) this.ctx.guardrailStreak = 0;
        break;
      case "guardrail":
        this.ctx.guardrailStreak += 1;
        this.lastGuardrailStep = this.ctx.step;
        break;
      case "run_start":
        this.ctx = { ...IDLE_TURN_CONTEXT };
        break;
      default:
        break;
    }
  }

  private decayGuardrail(): void {
    if (this.lastGuardrailStep >= 0 && this.ctx.step - this.lastGuardrailStep >= GUARDRAIL_DECAY_STEPS) {
      this.ctx.guardrailStreak = 0;
      this.lastGuardrailStep = -1;
    }
  }
}
