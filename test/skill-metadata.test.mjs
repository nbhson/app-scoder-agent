/**
 * M5: skill metadata chuẩn Anthropic — allowed-tools/license/when-to-use;
 * thiếu description → skip + warn; trùng name → warn, project wins.
 * Chạy: node --test test/skill-metadata.test.mjs (sau khi npm run build)
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discoverSkills, loadSkillFile, skillWarnings } from "../dist/skills.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  skillWarnings.length = 0;
});

function makeSkill(name, fm, body = "x") {
  dir = mkdtempSync(join(tmpdir(), "m5-"));
  mkdirSync(join(dir, ".scoder", "skills", name), { recursive: true });
  writeFileSync(join(dir, ".scoder", "skills", name, "SKILL.md"), `---\n${fm}\n---\n${body}`);
}

describe("M5 — skill metadata Anthropic", () => {
  it("allowed-tools / license / when-to-use parse vào Skill", () => {
    makeSkill("full", "name: full\ndescription: d\nallowed-tools: read_file, grep\nlicense: MIT\nwhen-to-use: khi cần đọc code");
    const s = loadSkillFile(join(dir, ".scoder", "skills", "full", "SKILL.md"), "project");
    assert.deepEqual(s.allowedTools, ["read_file", "grep"]);
    assert.equal(s.license, "MIT");
    assert.equal(s.whenToUse, "khi cần đọc code");
  });

  it("thiếu description → skip + warn", () => {
    makeSkill("nodesc", "name: nodesc");
    const skills = discoverSkills(dir);
    assert.ok(!skills.some((s) => s.name === "nodesc"), "không load");
    assert.ok(skillWarnings.some((w) => w.message.includes("thiếu description")));
  });

  it("trùng name → warn + project wins", () => {
    // 2 skill cùng name trong cùng project root — Map cuối thắng.
    dir = mkdtempSync(join(tmpdir(), "m5dup-"));
    for (const dup of ["dup-a", "dup-b"]) {
      mkdirSync(join(dir, ".scoder", "skills", dup), { recursive: true });
      writeFileSync(join(dir, ".scoder", "skills", dup, "SKILL.md"), `---\nname: dup\ndescription: từ ${dup}\n---\nx`);
    }
    const skills = discoverSkills(dir);
    assert.equal(skills.filter((s) => s.name === "dup").length, 1, "chỉ 1 skill dup");
    assert.ok(skillWarnings.some((w) => w.message.includes("trùng tên")), JSON.stringify(skillWarnings));
  });
});
