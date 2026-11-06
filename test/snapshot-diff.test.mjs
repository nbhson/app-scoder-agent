/**
 * T-06 unit tests — SnapshotManager.diff (branch scope backend).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SnapshotManager } from "../dist/workspace/snapshot.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "t06-"));
  execSync("git init -q", { cwd: workdir });
  execSync("git config user.email t@t && git config user.name t", { cwd: workdir });
  writeFileSync(join(workdir, "a.txt"), "one\n");
  execSync("git add -A && git commit -qm init", { cwd: workdir });
});

afterEach(() => rmSync(workdir, { recursive: true, force: true }));

describe("SnapshotManager.diff (T-06)", () => {
  it("diff between two checkpoints shows the change", () => {
    const sm = new SnapshotManager(workdir, true);
    const cp1 = sm.capture("before");
    writeFileSync(join(workdir, "a.txt"), "one\ntwo\n");
    const cp2 = sm.capture("after");
    assert.ok(cp1 && cp2);
    const d = sm.diff(cp1.tree, cp2.tree);
    assert.ok(d, "diff should be non-null");
    assert.match(d, /\+two/);
  });
  it("diff vs worktree (to=null)", () => {
    const sm = new SnapshotManager(workdir, true);
    const cp1 = sm.capture("before");
    writeFileSync(join(workdir, "a.txt"), "changed\n");
    const d = sm.diff(cp1.tree, null);
    assert.ok(d);
    assert.match(d, /changed/);
  });
  it("no change → null", () => {
    const sm = new SnapshotManager(workdir, true);
    const cp1 = sm.capture("a");
    const cp2 = sm.capture("b");
    assert.ok(cp1 && cp2);
    assert.equal(sm.diff(cp1.tree, cp2.tree), null);
  });
  it("disabled → null", () => {
    const sm = new SnapshotManager(workdir, false);
    assert.equal(sm.diff("head", null), null);
  });
});
