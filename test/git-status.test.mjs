/**
 * P7 — git context for the BuildRail: pure porcelain parser + chip format +
 * a real probe against a throwaway repo (branch + dirty transitions).
 * Chạy: node --test test/git-status.test.mjs (sau khi npm run build)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitStatusOut, gitChip, probeGitContext } from "../dist/workspace/git-status.js";

describe("parseGitStatusOut", () => {
  it("branch thường + dirty count", () => {
    const g = parseGitStatusOut("## main...origin/main [ahead 2]\n M src/a.ts\nM  src/b.ts\n?? new.py\n");
    assert.deepEqual(g, { branch: "main", detached: false, dirty: 3 });
  });

  it("rename `R old -> new` tính 1 entry", () => {
    const g = parseGitStatusOut("## dev\nR  old.ts -> new.ts\n");
    assert.equal(g.dirty, 1);
    assert.equal(g.branch, "dev");
  });

  it("unmerged (UU/AA) vẫn đếm", () => {
    const g = parseGitStatusOut("## rebase-branch\nUU a.ts\nAA b.ts\nD  c.ts\n");
    assert.equal(g.dirty, 3);
  });

  it("deleted + type-change", () => {
    const g = parseGitStatusOut("## fix/x\n D gone.md\nT mode-change\n");
    assert.equal(g.dirty, 2);
  });

  it("repo sạch → dirty 0", () => {
    assert.equal(parseGitStatusOut("## main...origin/main\n").dirty, 0);
  });

  it("detached HEAD + no commits yet", () => {
    const d = parseGitStatusOut("## HEAD (no branch)\n M a\n");
    assert.equal(d.branch, "HEAD");
    assert.equal(d.detached, true);
    const n = parseGitStatusOut("## No commits yet on master\n?? a\n");
    assert.equal(n.branch, "master");
  });

  it("`!!` ignored không đếm, output rác → null", () => {
    assert.equal(parseGitStatusOut("## main\n!! ignored/\n M a\n").dirty, 1);
    assert.equal(parseGitStatusOut(""), null);
    assert.equal(parseGitStatusOut("On branch main\nnothing to commit"), null);
  });
});

describe("gitChip", () => {
  it("null → không render; sạch → chỉ branch; dirty → ` · ±N`", () => {
    assert.equal(gitChip(null), null);
    assert.equal(gitChip({ branch: "main", detached: false, dirty: 0 }), "main");
    assert.equal(gitChip({ branch: "feat/x", detached: false, dirty: 12 }), "feat/x · ±12");
  });
});

// Real-repo fixture lives at module scope so `after` can clean it up.
const tmp = mkdtempSync(join(tmpdir(), "scoder-git-"));

describe("probeGitContext — repo thật", () => {
  const git = (args) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" });
  git(["init", "-b", "main", "--quiet"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(tmp, "a.txt"), "1\n");
  git(["add", "a.txt"]);
  git(["commit", "-qm", "init"]);

  it("sạch → branch + dirty 0", async () => {
    const g = await probeGitContext(tmp);
    assert.equal(g.branch, "main");
    assert.equal(g.dirty, 0);
  });

  it("sửa file → dirty 1 (stale-while-revalidate thấy ngay)", async () => {
    writeFileSync(join(tmp, "a.txt"), "2\n");
    const g = await probeGitContext(tmp);
    assert.equal(g.dirty, 1);
  });

  it("không phải git repo → null, không throw", async () => {
    const bare = mkdtempSync(join(tmpdir(), "scoder-nogit-"));
    try {
      assert.equal(await probeGitContext(bare), null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("workdir ma → null", async () => {
    assert.equal(await probeGitContext(join(tmp, "does-not-exist")), null);
  });
});
after(() => rmSync(tmp, { recursive: true, force: true }));
