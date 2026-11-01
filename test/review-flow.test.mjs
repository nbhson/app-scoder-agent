// Self-check: /review prompt-gate flow wiring in the compiled TUI.
// T2: state machine lives in dist/tui/review.js; app.js wires submit → review.
// Verifies the state machine handles both pending stages, finalizes with
// approved/cancelled, and echoes the server's rewritten_prompt verbatim
// (never user/LLM text) — the security property of the gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const machine = readFileSync(new URL("../dist/tui/review.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../dist/tui/app.js", import.meta.url), "utf8");

test("/review prompt-gate flow wiring", () => {
  assert.match(machine, /pending_level_selection/);
  assert.match(machine, /pending_user_selection/);
  assert.match(machine, /"approved"/);
  assert.match(machine, /"cancelled"/);
  // Security: approval echoes the exact text the user saw (server's copy).
  assert.match(machine, /rewritten_prompt/);
  // Level menu light/balanced/detailed mapped by numeric choice.
  assert.match(machine, /\["light",\s*"balanced",\s*"detailed"\]/);
  // App wires the submit path to the machine.
  assert.match(app, /reviewFromResponse/);
  assert.match(app, /reviewAnswerToCall/);
});
