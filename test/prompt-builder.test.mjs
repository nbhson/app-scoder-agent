/**
 * I3: prompt-builder — module thuần lắp system prompt.
 * Chạy: node --test test/prompt-builder.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvInfo, buildSkillsBlock, buildAgentsBlock } from "../dist/context/prompt-builder.js";

describe("buildEnvInfo (I3)", () => {
  it("chứa platform + node version + today", () => {
    const s = buildEnvInfo(process.cwd());
    assert.match(s, /Environment: \w+ · node v/);
    assert.match(s, /today \d{4}-\d{2}-\d{2}/);
  });
});

describe("buildSkillsBlock (I3)", () => {
  it("không có skill → chuỗi rỗng", () => {
    assert.equal(buildSkillsBlock([]), "");
  });

  it("có skill → AVAILABLE SKILLS + index + dynamic selection hint", () => {
    const s = buildSkillsBlock([{ name: "rev", description: "review code", path: "/p", scope: "project", body: "" }]);
    assert.match(s, /AVAILABLE SKILLS/);
    assert.match(s, /- rev: review code/);
    assert.match(s, /Do NOT load skills merely because they are listed/);
  });
});

describe("buildAgentsBlock (I3)", () => {
  const agents = [
    { name: "build", description: "build + fix", mode: "all" },
    { name: "plan", description: "planner", mode: "primary" },
    { name: "explore", description: "read-only explore", mode: "subagent" },
    { name: "researcher", description: "custom subagent", mode: "subagent" },
    { name: "secret-agent", description: "hidden", mode: "subagent", hidden: true },
  ];

  it("allowSubagents false → rỗng", () => {
    assert.equal(buildAgentsBlock(agents, false), "");
  });

  it("allow → advertise mode subagent|all (kể cả custom), bỏ primary-only & hidden", () => {
    const s = buildAgentsBlock(agents, true);
    assert.match(s, /SUBAGENTS/);
    assert.match(s, /explore/);
    assert.match(s, /researcher/, "user-defined mode:subagent phải được advertise");
    assert.match(s, /build/, "mode:all dùng được làm subagent");
    assert.ok(!/\bplan\b/.test(s), "primary-only không phải subagent (so khớp từ, không phải substring)");
    assert.ok(!s.includes("secret-agent"), "hidden không advertise");
  });
});
