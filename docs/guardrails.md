# Guardrail Engine

The Guardrail Engine wraps the autonomous loop with safety and progress rules. Each rule is a pure function over the step context that returns a decision.

## Default Rules

| Rule | Description |
|------|-------------|
| `wrap-up` | Inject reminder N steps before budget ends |
| `chat-done` | End conversational turns (marker-based) without build |
| `completion-claim` | Never trust "done" — force build verification |
| `text-only-streak` | End after N consecutive tool-less steps |
| `continue-nudge` | Nudge plain-text answers back to work |
| `doom-loop` | Intervene after N identical tool-call batches |
| `error-loop` | Force strategy change after N same tool+error repeats |
| `token-no-progress` | End run after N near-empty LLM responses |
| `build-stop` | End when build command succeeds |
| `history-trim` | Routine context trimming |
| `token-budget` | End when total session tokens exceed cap |

## Configuring Thresholds

Via `.scoderrc.json`:

```json
{
  "guardrails": {
    "textOnlyStreakLimit": 2,
    "doomLoopRepeats": 2,
    "wrapUpStepsBeforeEnd": 2,
    "tokenBudget": 500000
  }
}
```

## Rule Actions

Each triggered rule returns an action:

| Action | Behavior |
|--------|----------|
| `inject` | Push a reminder (role=user) into messages |
| `finish` | End the run (chat-only or verified build) |
| `verify-build` | Run build independently to verify |
| `trim` | Trim message history |
| `none` | No action |

## Events

Every triggered decision is logged to JSONL and emitted as an `AgentEvent`:

```json
{ "type": "guardrail", "rule": "doom-loop", "action": "inject", "reason": "..." }
```

TUI renders a human-readable notice:
```
⚠ agent reminder: agent trả lời text mà không dùng tool — nhắc tiếp tục làm việc
```

## Custom Rules

Register additional rules at runtime:

```typescript
import { createGuardrailEngine } from "./guardrails.js";

const engine = createGuardrailEngine({
  textOnlyStreakLimit: 3,
  doomLoopRepeats: 3,
});

engine.register({
  name: "my-rule",
  description: "...",
  evaluate(ctx) {
    if (ctx.step >= ctx.maxSteps - 5) {
      return { action: { kind: "finish", success: false, summary: "Out of time" }, reason: "..." };
    }
    return null;
  }
});
```