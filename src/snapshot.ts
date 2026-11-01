/**
 * Snapshot & undo — git shadow repository (H-11).
 *
 * Source: anomalyco/opencode (packages/core/src/snapshot.ts) — pattern
 * adapted: a separate git directory under .scoder/snapshot/ shares the
 * project worktree; each write-batch captures a checkpoint commit. `git`
 * binary required; best-effort (failures never crash the run).
 *
 * Layout: .scoder/snapshot/ (GIT_DIR, bare-ish) + checkpoint log in memory.
 * Restore: `git checkout <tree> -- .` onto the worktree via the shadow.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export interface SnapshotEntry {
  id: string; // checkpoint id ("n" sequential + tree hash)
  tree: string; // git tree hash
  ts: string;
  /** Tool calls that were about to run (for undo labeling). */
  label: string;
}

/** True when `git` is on PATH and the workdir is inside a git repo (or can be). */
function gitAvailable(workdir: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: workdir, encoding: "utf8" });
  return r.status === 0;
}

export class SnapshotManager {
  private gitDir: string;
  private workdir: string;
  private enabled: boolean;
  private checkpoints: SnapshotEntry[] = [];
  private initialized = false;
  private available = false;
  /** Set when the project has no .git — fallback: no-op (copy-tree skipped, see ponytail). */
  readonly degradedReason: string | null = null;

  constructor(workdir: string, enabled: boolean) {
    this.workdir = resolve(workdir);
    this.gitDir = join(this.workdir, ".scoder", "snapshot");
    this.enabled = enabled;
    if (!enabled) {
      this.degradedReason = null;
      return;
    }
    try {
      if (!gitAvailable(this.workdir)) {
        this.degradedReason = "git binary unavailable or not a repo — snapshots disabled (fallback copy-tree not enabled)";
        return;
      }
      mkdirSync(this.gitDir, { recursive: true });
      this.available = true;
    } catch (err) {
      this.degradedReason = (err as Error).message;
    }
  }

  /** Lazily init the shadow repo (first capture only). */
  private init(): boolean {
    if (this.initialized) return this.available;
    this.initialized = true;
    if (!this.available) return false;
    const ok = (args: string[]) => spawnSync("git", args, { cwd: this.workdir, env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workdir }, encoding: "utf8" });
    try {
      if (!existsSync(join(this.gitDir, "HEAD"))) {
        if (ok(["init", "--quiet", this.gitDir]).status !== 0) {
          this.available = false;
          return false;
        }
      }
      // Ignore everything except what we track: snapshot repo has its own index.
      this.available = true;
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  /** Capture current state as a checkpoint. Returns the tree hash or null. */
  capture(label: string): SnapshotEntry | null {
    if (!this.enabled || !this.init()) return null;
    const run = (args: string[]) =>
      spawnSync("git", args, {
        cwd: this.workdir,
        encoding: "utf8",
        env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workdir },
      });
    try {
      // Add all (shadow index is independent from the project's index).
      if (run(["add", "-A", "--", ".", ":(exclude).scoder"]).status !== 0) return null;
      const tree = run(["write-tree"]);
      if (tree.status !== 0) return null;
      const hash = tree.stdout.trim();
      // Empty tree (nothing changed vs previous checkpoint) — still record.
      const ts = new Date().toISOString();
      const id = `cp${this.checkpoints.length + 1}-${hash.slice(0, 8)}`;
      const entry: SnapshotEntry = { id, tree: hash, ts, label };
      this.checkpoints.push(entry);
      return entry;
    } catch {
      return null;
    }
  }

  /** List checkpoints (newest last). */
  list(): SnapshotEntry[] {
    return [...this.checkpoints];
  }

  /**
   * T-06: diff between two checkpoint trees (or tree vs current worktree
   * when `to` is null). Returns unified diff text or null.
   */
  diff(fromTree: string, toTree: string | null): string | null {
    if (!this.enabled || !this.init()) return null;
    const run = (args: string[]) =>
      spawnSync("git", args, {
        cwd: this.workdir,
        encoding: "utf8",
        env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workdir },
      });
    const args = toTree ? ["diff-tree", "-p", fromTree, toTree] : ["diff", fromTree];
    const r = run(args);
    if (r.status !== 0 && r.stdout.length === 0) return null;
    return r.stdout || null;
  }

  /** Revert tracked files to a checkpoint tree. Files added after it are deleted. */
  restore(tree: string): boolean {
    if (!this.enabled || !this.init()) return false;
    const run = (args: string[]) =>
      spawnSync("git", args, {
        cwd: this.workdir,
        encoding: "utf8",
        env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workdir },
      });
    try {
      // Index → checkpoint tree, then force-checkout all index entries.
      if (run(["read-tree", tree]).status !== 0) return false;
      if (run(["checkout-index", "-a", "-f"]).status !== 0) return false;
      // Delete files present in the workdir but absent from the checkpoint
      // (checkout-index cannot remove). Diff tree vs workdir via ls-files.
      const known = run(["ls-tree", "-r", "--name-only", tree]);
      if (known.status !== 0) return false;
      const treeFiles = new Set(known.stdout.trim().split("\n").filter(Boolean));
      const walk = (dir: string, rel: string) => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name === ".git" || e.name === ".scoder") continue;
          const abs = join(dir, e.name);
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(abs, r);
          else if (!treeFiles.has(r)) rmSync(abs, { force: true });
        }
      };
      walk(this.workdir, "");
      return true;
    } catch {
      return false;
    }
  }
}
