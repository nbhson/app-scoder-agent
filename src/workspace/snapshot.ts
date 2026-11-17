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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** Async git helper for the capture hot path (P-perf): `spawnSync` froze the
 * event loop for 100 ms–1 s+ on every write batch — TUI paint, SSE delivery
 * and LLM stream parsing all stall behind it. Same flags, non-blocking. */
function gitAsync(workdir: string, gitDir: string, args: string[]): Promise<{ status: number; stdout: string }> {
  return new Promise((res) => {
    const child = spawn("git", args, {
      cwd: workdir,
      env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: workdir },
    });
    let stdout = "";
    child.stdout?.on("data", (c: Buffer) => {
      if (stdout.length < 1_000_000) stdout += c.toString("utf8").slice(0, 1_000_000 - stdout.length);
    });
    child.stderr?.resume(); // drain so the child never blocks on a full pipe
    child.on("error", () => res({ status: -1, stdout: "" }));
    child.on("close", (code) => res({ status: code ?? -1, stdout }));
  });
}

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
  /**
   * P-perf (item 19): the git probe was MOVED OUT of the constructor. Every
   * `new Agent` — main run, every subagent, every resume — used to pay a
   * synchronous `git rev-parse` (10–100 ms of frozen event loop) even when
   * the run never writes a file. Now it happens lazily on first use; `capture`
   * (the only production entry point) probes asynchronously.
   * null = never probed; false = probed-degraded; true = probed-available.
   */
  private probed: boolean | null = null;
  /** Set when the project has no .git — fallback: no-op (copy-tree skipped, see ponytail). */
  degradedReason: string | null = null;

  constructor(workdir: string, enabled: boolean) {
    this.workdir = resolve(workdir);
    this.gitDir = join(this.workdir, ".scoder", "snapshot");
    this.enabled = enabled;
  }

  /** Shared field-update for both probe paths (sync fallback + async fast path). */
  private setProbeResult(gitOk: boolean): void {
    if (!gitOk) {
      this.degradedReason = "git binary unavailable or not a repo — snapshots disabled (fallback copy-tree not enabled)";
      this.probed = false;
      return;
    }
    try {
      mkdirSync(this.gitDir, { recursive: true });
      this.available = true;
      this.probed = true;
    } catch (err) {
      this.degradedReason = (err as Error).message;
      this.probed = false;
    }
  }

  /** Async probe for the capture hot path — no spawnSync on the event loop. */
  private async probeAsync(): Promise<void> {
    let ok: boolean;
    try {
      const r = await new Promise<{ status: number }>((res) => {
        const child = spawn("git", ["rev-parse", "--git-dir"], { cwd: this.workdir, env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } });
        child.stdout.resume();
        child.stderr.resume();
        child.on("error", () => res({ status: -1 }));
        child.on("close", (code) => res({ status: code ?? -1 }));
      });
      ok = r.status === 0;
    } catch {
      ok = false;
    }
    this.setProbeResult(ok);
  }

  /** Sync probe — only for the synchronous entry points (diff/restore, tests). */
  private ensureProbed(): void {
    if (this.probed !== null) return;
    this.setProbeResult(gitAvailable(this.workdir));
  }

  /** Lazily init the shadow repo (first capture only). */
  private init(): boolean {
    this.ensureProbed();
    if (!this.probed) return false;
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

  /**
   * Capture current state as a checkpoint. Returns the tree hash or null.
   * P-perf: async — this runs on every write batch inside the agent loop;
   * the previous `spawnSync` pair blocked the whole process for its duration.
   * Callers MUST await this before executing the write batch (the checkpoint
   * has to predate the modifications).
   */
  async capture(label: string): Promise<SnapshotEntry | null> {
    if (!this.enabled) return null;
    // Item 19: probe asynchronously on the hot path — capture is awaited by
    // the run loop, so the one-time git check must not block the event loop.
    if (this.probed === null) await this.probeAsync();
    if (!this.init()) return null;
    try {
      // Add all (shadow index is independent from the project's index).
      const add = await gitAsync(this.workdir, this.gitDir, ["add", "-A", "--", ".", ":(exclude).scoder"]);
      if (add.status !== 0) return null;
      const tree = await gitAsync(this.workdir, this.gitDir, ["write-tree"]);
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
        try {
          if (dir !== this.workdir && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
        } catch { /* best effort */ }
      };
      walk(this.workdir, "");
      return true;
    } catch {
      return false;
    }
  }
}
