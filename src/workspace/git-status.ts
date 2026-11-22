/**
 * P7 — lightweight git context for the TUI (branch + dirty count).
 *
 * Deliberately NOT the shadow-snapshot machinery: this is a display-only
 * probe. It reuses the async `spawn` pattern established in snapshot.ts
 * (P-perf item 19) — `spawnSync` would freeze the event loop inside the
 * render path, so every call here is promise-based, time-boxed and
 * best-effort: any failure yields `null` and the UI simply hides the chip.
 */
import { spawn } from "node:child_process";
import { Utf8Buffer } from "../shared/decode.js";

export interface GitContext {
  /** Current branch name; "HEAD" when detached, "no commits yet" for a fresh repo. */
  branch: string;
  /** True when HEAD is detached (`## HEAD (no branch)`). */
  detached: boolean;
  /** Number of changed working-tree entries (renames counted once). */
  dirty: number;
}

/**
 * Parse `git status --porcelain -b` output. Pure + exported for tests:
 * rename lines (`R  old -> new`) are ONE entry, unmerged (`U`/`AA`/`DD`)
 * count, comments/`!!` lines never do.
 */
export function parseGitStatusOut(out: string): GitContext | null {
  const lines = out.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0 || !lines[0].startsWith("## ")) return null;
  const header = lines[0].slice(3);
  const detached = header.startsWith("HEAD (no branch)");
  let branch: string;
  if (header.startsWith("No commits yet on ")) branch = header.slice("No commits yet on ".length);
  else if (detached) branch = "HEAD";
  // `main...origin/main [ahead 1]` → `main`; plain `main` stays.
  else branch = header.split("...")[0].split(" ")[0] || "HEAD";
  let dirty = 0;
  for (const line of lines.slice(1)) {
    // Every non-header line in porcelain v1 is one entry: `XY path` (renames
    // carry `old -> new` in a single line) or `?? path`. `!!` only appears
    // with --ignored and must stay invisible; git never emits bare comments.
    if (line.startsWith("!!") || line.startsWith("## ")) continue;
    dirty++;
  }
  return { branch, detached, dirty };
}

/** Run `git status --porcelain -b` without ever blocking the event loop. */
export function probeGitContext(workdir: string, timeoutMs = 1500): Promise<GitContext | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["status", "--porcelain", "-b"], {
        cwd: workdir,
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
      });
    } catch {
      resolve(null);
      return;
    }
    // P1-15: git paths/branch names are UTF-8 (Vietnamese branches); decoding
    // per chunk used to corrupt them at a boundary.
    const stdoutBuf = new Utf8Buffer(512_000);
    let done = false;
    const finish = (value: GitContext | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdoutBuf.push(c);
      if (stdoutBuf.length > 512_000) finish(null); // absurd output size — bail
    });
    child.stderr?.resume();
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? parseGitStatusOut(stdoutBuf.text) : null));
  });
}

/** `main · ±3` (dirty omitted when clean); null → render nothing. Clipping
 *  is the caller's job — display strings must go through text-width. */
export function gitChip(git: GitContext | null): string | null {
  if (!git) return null;
  return git.dirty > 0 ? `${git.branch} · ±${git.dirty}` : git.branch;
}
