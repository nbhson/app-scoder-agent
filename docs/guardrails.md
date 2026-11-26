# Guardrail Engine

The Guardrail Engine wraps the autonomous loop with safety and progress rules. Each rule is a pure function over the step context that returns a decision.

## Default Rules

| Rule | Description |
|------|-------------|
| `wrap-up` | Inject reminder N steps before budget ends |
| `chat-done` | End conversational turns (marker-based) without build |
| `completion-claim` | Never trust "done" — force build verification |
| `text-only-streak` | End after N consecutive tool-less steps |
| `continue-nudge` | Nudge plain-text answers back to work — never demands a build when no files changed; instead suggests the `<<CHAT_DONE>>` exit for pure Q&A. An **announced intention without a tool call** ("Tôi sẽ tìm…") is nudged to act, never treated as a finished chat turn |
| `doom-loop` | Intervene on repeated tool calls — see [Loop breaker](#loop-breaker-doom-loop--read-cache) |
| `no-new-information` | Intervene when tool **outputs** stop teaching the agent anything (<15% new lines for N consecutive steps) — catches the URL-counting loop that never repeats a call signature |
| `error-loop` | Force strategy change after N same tool+error repeats |
| `token-no-progress` | End run after N near-empty LLM responses |
| `build-stop` | End when build command succeeds |
| `history-trim` | Trim message history **only when it exceeds the token budget** (P0-1: keeping the prefix byte-stable protects the local engine's KV-cache; no cooldown-free per-step trimming) |
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

## Loop breaker (`doom-loop` + read cache)

Models served locally (llama.cpp / Ollama) frequently repeat work in a **cycle**
(`run command → analyse → grep → web fetch → run command …`) instead of repeating
one identical batch. `doomLoopRepeats` (N) drives three signals, narrowest to
widest — all measured on a **normalized** call signature, so a model that
re-serializes JSON with different key order or whitespace is still caught:

| Signal | Fires when |
|--------|-----------|
| `streak` | the same batch runs N+1 times **in a row** |
| `cycle` | a period of 2–4 steps repeats ≥2 times within the sliding window (16 batches) |
| `scattered` | the same **read-only** call appears N+2 times anywhere in the run |

Escalation: the first hit injects a reminder naming the pattern; a second hit (or a
pattern far past the threshold) **ends the run** with the model's last answer in the
summary — so the user gets a result instead of `reached max steps (40)`.

Mutating calls (`run_command`, `write_file`, `edit_file`, `apply_patch`) are excluded
from the `scattered` counter: re-running a build is a legitimate verify–fix loop.

Second layer (`src/agent/loop-cache.ts`): a read-only tool called again with the
same normalized arguments is **not executed** — the run replays the cached result
prefixed with `[DUPLICATE CALL … already ran at step N]`. The cache is per run, holds
only successful results, caps at 64 entries (FIFO) and is dropped entirely as soon as
any mutating tool runs, because the world changed.

Third layer (`no-new-information`): the dangerous local-model loop does **not** repeat
call signatures — it counts them (`/angular-22-1`, `-2`, … `/what-new/angular-22-39`),
and every response is the same page. This rule measures the tool **outputs**: a step
whose content is under 15% unseen lines counts toward a streak; N consecutive
uninformative steps inject a reminder, the next one ends the run with the model's last
answer. A successful mutating tool resets the streak (the world actually changed).

**No run ends empty** (`lastSubstantiveAnswer`, `src/agent/run-loop.ts`): whether the
model closes a turn with a bare `<<CHAT_DONE>>` marker or the budget runs out, the
summary is backfilled with the last real assistant answer from history — critical for
subagents, whose parent only sees this string.

Auditing: `node scripts/replay-guardrails.mjs --days 7` replays every logged run from
`~/.scoder/sessions` through the current engine and reports which steps the breakers
would have cut — production evidence, not unit fixtures.

## Rule Actions

> **Note:** `continue-nudge` never forces a build when no files have been modified. For a
> pure Q&A or explanation-only answer, it points the model at the `<<CHAT_DONE>>` marker
> exit (see `chat-done`) instead of burning steps running an empty build.

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
⚠ trả lời text chưa dùng tool — nhắc tiếp tục
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