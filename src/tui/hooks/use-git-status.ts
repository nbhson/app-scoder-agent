/**
 * P7 — git branch/dirty for the BuildRail, stale-while-revalidate.
 *
 * Rules that make this safe on the render hot path: the probe is async
 * (never spawnSync — same precedent as workspace/snapshot.ts), at most one
 * request per workdir in flight, results cached in a single slot, and `null`
 * simply hides the chip. Cadence: once per workdir, every ~5 s while idle,
 * and immediately when a run finishes — the agent's own edits are the most
 * likely thing to change the dirty count. Responses are dropped when the
 * workdir moved on (`/cd`, session resume) or a newer probe took over.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { probeGitContext, type GitContext } from "../../workspace/git-status.js";

/** 5 s: long enough that nobody notices the staleness, short enough that a
 *  `git checkout` elsewhere lands before the next run. */
export const GIT_REFRESH_MS = 5000;

export function useGitStatus(
  workdir: string,
  running: boolean,
  probe: (dir: string) => Promise<GitContext | null> = probeGitContext,
): GitContext | null {
  const [git, setGit] = useState<GitContext | null>(null);
  const reqId = useRef(0);
  const inflightDir = useRef<string | null>(null);
  const liveDir = useRef(workdir);
  useEffect(() => {
    liveDir.current = workdir;
  }, [workdir]);

  const refresh = useCallback(() => {
    if (inflightDir.current === workdir) return; // same dir already probing
    inflightDir.current = workdir;
    const mine = ++reqId.current;
    const settle = (value: GitContext | null): void => {
      if (inflightDir.current === workdir) inflightDir.current = null;
      // Drop stale results: a newer probe took over, or the dir moved.
      if (mine === reqId.current && liveDir.current === workdir) setGit(value);
    };
    probe(workdir).then(settle, () => settle(null));
  }, [workdir, probe]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      // While running the transcript repaints constantly — skip the poll and
      // catch up the moment the run ends (effect below).
      if (!running) refresh();
    }, GIT_REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh, running]);

  useEffect(() => {
    if (!running) refresh(); // finish → immediate refresh
  }, [running, refresh]);

  return git;
}
