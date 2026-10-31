/**
 * Unit tests cho prompt.js — versioning system prompt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildSystemPrompt } from "../dist/prompt.js";

describe("prompt — system prompt versioning", () => {
  it("PROMPT_VERSION là số nguyên dương", () => {
    assert.equal(typeof PROMPT_VERSION, "number");
    assert.ok(PROMPT_VERSION >= 1);
  });

  it("SYSTEM_PROMPT giữ các contract quan trọng với harness", () => {
    // Marker chat phải tồn tại nguyên vẹn — guardrail chat-done phụ thuộc nó
    assert.ok(SYSTEM_PROMPT.includes("<<CHAT_DONE>>"));
    // Stop condition qua build command
    assert.ok(/build command/i.test(SYSTEM_PROMPT));
    // load_skill + MCP có trong phần tool selection
    assert.ok(SYSTEM_PROMPT.includes("load_skill"));
    assert.ok(SYSTEM_PROMPT.includes("mcp__"));
  });

  it("buildSystemPrompt ghép phần động đúng thứ tự", () => {
    const out = buildSystemPrompt({
      workdir: "/tmp/w",
      buildCmd: "npm test",
      envInfo: "node v22",
      skillsBlock: "SKILLS: greet",
    });
    assert.ok(out.startsWith(SYSTEM_PROMPT), "phải bắt đầu bằng prompt gốc");
    assert.ok(out.includes("Working directory: /tmp/w"));
    assert.ok(out.includes("Build command (stop condition): npm test"));
    assert.ok(out.includes("node v22"));
    assert.ok(out.includes("SKILLS: greet"));
    // envInfo nằm trước skillsBlock
    assert.ok(out.indexOf("node v22") < out.indexOf("SKILLS: greet"));
  });
});
