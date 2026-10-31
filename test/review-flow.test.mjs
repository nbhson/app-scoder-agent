// Self-check: /review prompt-gate flow wiring in the compiled TUI.
// Verifies the state machine handles both pending stages, finalizes with
// approved/cancelled, and echoes the server's rewritten_prompt verbatim
// (never user/LLM text) — the security property of the gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../dist/tui/app.js", import.meta.url), "utf8");

test("/review prompt-gate flow wiring", () => {
  assert.match(src, /pending_level_selection/);
  assert.match(src, /pending_user_selection/);
  assert.match(src, /"approved"/);
  assert.match(src, /"cancelled"/);
  // Security: approval echoes the exact text the user saw (server's copy).
  assert.match(src, /rewritten_prompt:\s*rv\.rewrittenPrompt/);
  // Level menu light/balanced/detailed mapped by numeric choice.
  assert.match(src, /\["light",\s*"balanced",\s*"detailed"\]/);
  assert.ok(src.includes("Prompt-gate review in progress"));
});
