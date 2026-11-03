/**
 * Unit tests cho SnapshotManager (H-11 — git shadow repo).
 * Chạy: node --test test/snapshot.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SnapshotManager } from "../dist/snapshot.js";

/** @type {string} */
let workdir;

function initProjectRepo(wd) {
  spawnSync("git", ["init", "--quiet"], { cwd: wd });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: wd });
  spawnSync("git", ["config", "user.name", "t"], { cwd: wd });
  writeFileSync(join(wd, "a.txt"), "hello\n");
  spawnSync("git", ["add", "-A"], { cwd: wd });
  spawnSync("git", ["commit", "--quiet", "-m", "init"], { cwd: wd });
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "snap-"));
  initProjectRepo(workdir);
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("SnapshotManager — capture + restore", () => {
  it("capture creates a checkpoint with tree hash", () => {
    const sm = new SnapshotManager(workdir, true);
    const cp = sm.capture("test batch");
    assert.ok(cp, "checkpoint created");
    assert.match(cp.id, /^cp1-/);
    assert.match(cp.tree, /^[0-9a-f]{40}$/);
    assert.equal(cp.label, "test batch");
  });

  it("multiple captures + list ordering", () => {
    const sm = new SnapshotManager(workdir, true);
    sm.capture("first");
    writeFileSync(join(workdir, "a.txt"), "changed\n");
    sm.capture("second");
    const list = sm.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].label, "first");
    assert.equal(list[1].label, "second");
    assert.notEqual(list[0].tree, list[1].tree, "trees differ after change");
  });

  it("restore reverts file changes to a checkpoint", () => {
    const sm = new SnapshotManager(workdir, true);
    sm.capture("before");
    writeFileSync(join(workdir, "a.txt"), "broken change\n");
    writeFileSync(join(workdir, "b.txt"), "new file\n");
    const list = sm.list();
    const ok = sm.restore(list[0].tree);
    assert.equal(ok, true);
    assert.equal(readFileSync(join(workdir, "a.txt"), "utf8"), "hello\n", "content reverted");
    assert.ok(!existsSync2(join(workdir, "b.txt")), "added file removed on restore");
  });

  it("disabled manager captures nothing", () => {
    const sm = new SnapshotManager(workdir, false);
    assert.equal(sm.capture("x"), null);
    assert.equal(sm.list().length, 0);
  });

  it("non-git directory → degraded, never throws", () => {
    const wd = mkdtempSync(join(tmpdir(), "nogit-"));
    try {
      const sm = new SnapshotManager(wd, true);
      assert.equal(sm.capture("x"), null);
      assert.ok(sm.degradedReason, "degraded reason set");
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("checkpoint survives write to subdirectory", () => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    const sm = new SnapshotManager(workdir, true);
    sm.capture("cp0");
    writeFileSync(join(workdir, "src", "x.ts"), "export {};\n");
    const list = sm.list();
    sm.restore(list[0].tree);
    assert.ok(!existsSync2(join(workdir, "src", "x.ts")));
  });
});

function existsSync2(p) {
  return existsSync(p);
}
