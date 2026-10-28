/**
 * Session persistence: save agent state (messages, steps, build) to
 * <workdir>/.scoder/sessions/<id>.json after every step so runs can be resumed.
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatMessage } from "./llm.js";

export interface SessionFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  task: string;
  model: string;
  provider: string;
  buildCmd: string | null;
  steps: number;
  maxSteps: number;
  messages: ChatMessage[];
  lastBuild: { success: boolean; command: string; output: string } | null;
}

const SESSIONS_DIR = ".scoder/sessions";

export function newSessionId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${y}${mo}${d}-${h}${mi}${s}-${rand}`;
}

function sessionsDir(workdir: string): string {
  return resolve(workdir, SESSIONS_DIR);
}

/** Atomic write: write to .tmp then rename. */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export class SessionStore {
  readonly id: string;
  private filePath: string;
  private enabled: boolean;
  private readonly _workdir: string;

  constructor(
    workdir: string,
    enabled: boolean,
    id = newSessionId(),
  ) {
    this.id = id;
    this._workdir = workdir;
    this.enabled = enabled;
    this.filePath = join(sessionsDir(workdir), `${id}.json`);
  }

  save(data: Omit<SessionFile, "id" | "createdAt" | "updatedAt">, createdAt?: string): void {
    if (!this.enabled) return;
    try {
      mkdirSync(sessionsDir(this._workdir), { recursive: true });
      const now = new Date().toISOString();
      const full: SessionFile = {
        ...data,
        id: this.id,
        createdAt: createdAt ?? now,
        updatedAt: now,
      };
      atomicWrite(this.filePath, JSON.stringify(full, null, 2));
    } catch (err) {
      // Never crash the agent because of a logging/persistence failure
      console.error(`⚠  session save failed: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Load / list / prune
// ---------------------------------------------------------------------------

export function loadSession(workdir: string, id: string): SessionFile | null {
  const path = join(sessionsDir(workdir), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionFile;
  } catch {
    return null;
  }
}

export interface SessionSummary {
  id: string;
  task: string;
  steps: number;
  updatedAt: string;
}

export function listSessions(workdir: string): SessionSummary[] {
  const dir = sessionsDir(workdir);
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const f of readdirSync(dir).sort().reverse()) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as SessionFile;
      out.push({
        id: s.id,
        task: (s.task ?? "").slice(0, 60),
        steps: s.steps ?? 0,
        updatedAt: s.updatedAt ?? "",
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Delete session files older than `days` (default 7).
 * Completed sessions (lastBuild.success === true) are removed; sessions that
 * did NOT finish successfully are kept longer — they may still be worth
 * resuming. Returns count removed.
 */
export function pruneSessions(workdir: string, days = 7): number {
  const dir = sessionsDir(workdir);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const full = join(dir, f);
    try {
      const st = statSync(full);
      if (st.mtimeMs >= cutoff) continue;
      const s = JSON.parse(readFileSync(full, "utf8")) as SessionFile;
      const completed = s.lastBuild?.success === true;
      if (completed) {
        rmSync(full);
        removed++;
      }
    } catch {
      // malformed JSON — prune it (unreadable session is worthless)
      try { rmSync(full); removed++; } catch { /* ignore */ }
    }
  }
  return removed;
}

/** Resolve "last" or an explicit id to a SessionFile, or null. */
export function resolveSessionId(workdir: string, idOrLast: string): SessionFile | null {
  if (idOrLast === "last") {
    const all = listSessions(workdir);
    if (all.length === 0) return null;
    return loadSession(workdir, all[0].id);
  }
  return loadSession(workdir, idOrLast);
}
