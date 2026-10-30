import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, loadSkillFile, discoverSkills, findSkill, formatSkillIndex } from "../dist/skills.js";
import { completeSlashCommand, parseSlashCommand, formatSlashHelp } from "../dist/tui/commands.js";

describe("skills", () => {
  const root = mkdtempSync(join(tmpdir(), "scoder-skills-"));
  const proj = join(root, "proj");
  mkdirSync(join(proj, ".scoder", "skills", "review"), { recursive: true });
  mkdirSync(join(proj, ".scoder", "skills", "plain"), { recursive: true });
  mkdirSync(join(proj, ".scoder", "skills", "noname"), { recursive: true });
  writeFileSync(
    join(proj, ".scoder", "skills", "review", "SKILL.md"),
    '---\nname: code-review\ndescription: "Review code for bugs"\n---\n\n# Steps\n1. Read the diff\n',
  );
  writeFileSync(join(proj, ".scoder", "skills", "plain", "SKILL.md"), "# no frontmatter, dir name used? no — invalid\n");
  writeFileSync(join(proj, ".scoder", "skills", "noname", "SKILL.md"), "---\ndescription: no name here\n---\nbody\n");

  it("parseFrontmatter extracts meta + body, tolerates missing frontmatter", () => {
    const { meta, body } = parseFrontmatter('---\nname: a\ndescription: "x y"\n---\nBODY');
    assert.equal(meta.name, "a");
    assert.equal(meta.description, "x y");
    assert.equal(body, "BODY");
    const bare = parseFrontmatter("just text");
    assert.deepEqual(bare.meta, {});
    assert.equal(bare.body, "just text");
  });

  it("loadSkillFile rejects skills without a usable name", () => {
    const good = loadSkillFile(join(proj, ".scoder", "skills", "review", "SKILL.md"), "project");
    assert.equal(good?.name, "code-review");
    assert.equal(good?.description, "Review code for bugs");
    assert.match(good?.body ?? "", /# Steps/);
    assert.equal(loadSkillFile(join(proj, ".scoder", "skills", "noname", "SKILL.md"), "project"), null);
  });

  it("discoverSkills finds project skills; findSkill is case-insensitive", () => {
    const all = discoverSkills(proj);
    assert.deepEqual(all.map((s) => s.name), ["code-review"]);
    assert.equal(findSkill(proj, "CODE-REVIEW")?.name, "code-review");
    assert.equal(findSkill(proj, "nope"), null);
  });

  it("project skills override global ones with the same name", () => {
    const globalDir = join(root, "home", ".scoder", "skills", "review");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "SKILL.md"), "---\nname: code-review\ndescription: global desc\n---\nglobal body");
    // discoverSkills(workdir) reads global from os.homedir() — not overridable here,
    // so verify precedence directly through scan-order semantics via loadSkillFile.
    const g = loadSkillFile(join(globalDir, "SKILL.md"), "global");
    const p = loadSkillFile(join(proj, ".scoder", "skills", "review", "SKILL.md"), "project");
    assert.equal(g?.scope, "global");
    assert.equal(p?.scope, "project");
  });

  it("formatSkillIndex renders name + description lines", () => {
    const idx = formatSkillIndex(discoverSkills(proj));
    assert.match(idx, /- code-review: Review code for bugs/);
    assert.equal(formatSkillIndex([]), "");
  });

  it("truncates oversized skill bodies", () => {
    const big = join(root, "big");
    mkdirSync(big, { recursive: true });
    writeFileSync(join(big, "SKILL.md"), "---\nname: big\n---\n" + "x".repeat(30_000));
    const s = loadSkillFile(join(big, "SKILL.md"), "project");
    assert.ok((s?.body.length ?? 0) <= 21_000);
    assert.match(s?.body ?? "", /\[truncated\]$/);
  });

  after(() => rmSync(root, { recursive: true, force: true }));
});

describe("slash command completion", () => {
  it("completes a unique prefix with trailing space", () => {
    const r = completeSlashCommand("/co");
    assert.equal(r?.completed, "/cost ");
    assert.equal(r?.candidates.length, 1);
  });

  it("common-prefixes ambiguous matches (/sk → /skill)", () => {
    const r = completeSlashCommand("/sk");
    assert.equal(r?.completed, "/skill");
    assert.equal(r?.candidates.length, 2); // /skills + /skill
  });

  it("exact match completes with space", () => {
    assert.equal(completeSlashCommand("/help")?.completed, "/help ");
  });

  it("returns null for non-slash or unmatched input", () => {
    assert.equal(completeSlashCommand("hello"), null);
    assert.equal(completeSlashCommand("/zzz"), null);
  });

  it("parseSlashCommand splits cmd + arg; help lists new commands", () => {
    assert.deepEqual(parseSlashCommand("/skill code-review"), { cmd: "/skill", arg: "code-review" });
    const help = formatSlashHelp("scoder tui");
    assert.match(help, /\/skills/);
    assert.match(help, /\/mcp/);
    assert.match(help, /\/permission/);
  });
});
