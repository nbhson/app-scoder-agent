/**
 * Session persistence v2: durable event log + projections.
 *
 * Source: anomalyco/opencode (packages/core/src/session/stored.ts, run-coordinator.ts;
 * specs/v2/session.md) — pattern adapted: event-sourced JSONL log as the durable
 * source, in-memory projection for messages, write-ahead execution claim for
 * crash recovery. Falls back to reading v1 JSON snapshots transparently.
 *
 * Layout:
 *   <workdir>/.scoder/sessions/<id>.json       — v1 snapshot (legacy, read-only)
 *   <workdir>/.scoder/sessions/<id>/events.jsonl — v2 durable event log
 *   <workdir>/.scoder/sessions/<id>/manifest.json — projection summary
 */
import { mkdirSync, writeFileSync, appendFileSync, renameSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
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
  /** Accumulated LLM token usage (enterprise cost tracking, optional for older sessions). */
  usage?: {
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
}

/** Durable event — one JSON line in events.jsonl. */
export interface SessionEvent {
  ts: string;
  type:
    | "run.started"
    | "message.added"
    | "tool.started"
    | "tool.result"
    | "retry.scheduled"
    | "execution.claimed"
    | "execution.released"
    | "guardrail.decision"
    | "build.checked"
    | "compaction.ran"
    | "steer.enqueued"
    | "finish"
    | "error";
  /** Event schema version for forward-compatible readers. */
  v: 1;
  /** Session-unique monotonic sequence (per-event, assigned by the store). */
  seq: number;
  [key: string]: unknown;
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

function eventLogPath(workdir: string, id: string): string {
  return join(sessionsDir(workdir), id, "events.jsonl");
}

function manifestPath(workdir: string, id: string): string {
  return join(sessionsDir(workdir), id, "manifest.json");
}

/** Atomic write: write to .tmp then rename. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** ---------------------------------------------------------------------
 * Event-sourced store (v2)
 * ------------------------------------------------------------------- */
export class EventSessionStore {
  readonly id: string;
  private enabled: boolean;
  private readonly _workdir: string;
  private seq = 0;
  private createdAt: string;
  private logPath: string;
  /** In-memory projection: message history (append-only). */
  private _messages: ChatMessage[] = [];
  private _task = "";
  private _steps = 0;
  private _lastBuild: SessionFile["lastBuild"] = null;
  private _usage: SessionFile["usage"] = undefined;
  private _finished: { success: boolean; summary: string } | null = null;

  constructor(workdir: string, enabled: boolean, id = newSessionId()) {
    this.id = id;
    this._workdir = workdir;
    this.enabled = enabled;
    this.createdAt = new Date().toISOString();
    this.logPath = eventLogPath(workdir, id);
    if (enabled) {
      try {
        mkdirSync(resolve(this.logPath, ".."), { recursive: true });
      } catch (err) {
        // Never crash the agent because of a persistence failure
        console.error(`⚠  session store init failed: ${(err as Error).message}`);
        this.enabled = false;
      }
    }
  }

  get workdir(): string {
    return this._workdir;
  }

  /** Append one durable event (fsync-free appendFileSync is atomic enough per line on POSIX). */
  append(event: Omit<SessionEvent, "ts" | "seq" | "v"> & { ts?: string }): void {
    if (!this.enabled) return;
    try {
      const full: SessionEvent = {
        ts: event.ts ?? new Date().toISOString(),
        v: 1,
        seq: ++this.seq,
        ...event,
      } as SessionEvent;
      appendFileSync(this.logPath, JSON.stringify(full) + "\n", "utf8");
      this.project(full);
    } catch (err) {
      console.error(`⚠  event append failed: ${(err as Error).message}`);
    }
  }

  /** Update the in-memory projection from an event. */
  private project(ev: SessionEvent): void {
    switch (ev.type) {
      case "run.started":
        this._task = String(ev.task ?? "");
        break;
      case "message.added":
        this._messages.push(ev.message as ChatMessage);
        break;
      case "build.checked":
        this._lastBuild = {
          success: Boolean(ev.success),
          command: String(ev.command ?? ""),
          output: String(ev.output ?? "").slice(0, 10_000),
        };
        break;
      case "finish":
        this._finished = { success: Boolean(ev.success), summary: String(ev.summary ?? "") };
        break;
      default:
        break; // tool/guardrail/etc. events are queryable from the raw log
    }
  }

  /** Materialized message history (projection). */
  get messages(): ChatMessage[] {
    return this._messages;
  }

  /** Write-ahead execution claim — stamped when a step begins executing. */
  claimExecution(attempt: number): void {
    this.append({
      type: "execution.claimed",
      attempt,
      pid: process.pid,
      host: process.env.HOSTNAME ?? "localhost",
    });
  }

  releaseExecution(attempt: number): void {
    this.append({ type: "execution.released", attempt });
  }

  /** Crash recovery: sessions with a stale claim (no matching release). */
  static hasStaleClaim(workdir: string, id: string): boolean {
    const events = readEventLog(workdir, id);
    let claimed = 0;
    let released = 0;
    for (const ev of events) {
      if (ev.type === "execution.claimed") claimed++;
      if (ev.type === "execution.released") released++;
    }
    return claimed > released;
  }

  /** Full projection → the v1 SessionFile shape (resume/read compatibility). */
  toSessionFile(): SessionFile {
    return {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      task: this._task,
      model: "",
      provider: "",
      buildCmd: null,
      steps: this._steps,
      maxSteps: 0,
      messages: this._messages,
      lastBuild: this._lastBuild,
      usage: this._usage,
    };
  }

  get finished(): { success: boolean; summary: string } | null {
    return this._finished;
  }

  /** Persist a manifest (cheap summary for /sessions listing). */
  writeManifest(meta: { task: string; model: string; provider: string; buildCmd: string | null; steps: number; maxSteps: number; usage?: SessionFile["usage"] }): void {
    if (!this.enabled) return;
    try {
      atomicWrite(manifestPath(this._workdir, this.id), JSON.stringify({
        id: this.id,
        createdAt: this.createdAt,
        updatedAt: new Date().toISOString(),
        lastBuild: this._lastBuild,
        finished: this._finished,
        eventCount: this.seq,
        ...meta,
      }, null, 2));
      this._steps = meta.steps;
      this._usage = meta.usage;
    } catch (err) {
      console.error(`⚠  manifest write failed: ${(err as Error).message}`);
    }
  }
}

/** Read the raw event log of a session (empty array when missing/malformed lines). */
export function readEventLog(workdir: string, id: string): SessionEvent[] {
  const p = eventLogPath(workdir, id);
  if (!existsSync(p)) return [];
  const out: SessionEvent[] = [];
  try {
    const text = readFileSync(p, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SessionEvent);
      } catch {
        // skip malformed line (torn write on crash) — remaining lines stay valid
      }
    }
  } catch {
    return [];
  }
  return out;
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
  // v2 event-sourced session directory first
  const v2Dir = join(sessionsDir(workdir), id);
  if (existsSync(v2Dir) && statSync(v2Dir).isDirectory()) {
    return sessionFromEventLog(workdir, id);
  }
  const path = join(sessionsDir(workdir), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionFile;
  } catch {
    return null;
  }
}

/** Rebuild a SessionFile projection from a v2 event log (null when no log). */
export function sessionFromEventLog(workdir: string, id: string): SessionFile | null {
  const events = readEventLog(workdir, id);
  if (events.length === 0) return null;
  const messages: ChatMessage[] = [];
  let task = "";
  let lastBuild: SessionFile["lastBuild"] = null;
  let createdAt = "";
  let updatedAt = "";
  for (const ev of events) {
    createdAt = createdAt || ev.ts;
    updatedAt = ev.ts;
    if (ev.type === "run.started") task = String(ev.task ?? "");
    else if (ev.type === "message.added") messages.push(ev.message as ChatMessage);
    else if (ev.type === "build.checked") {
      lastBuild = { success: Boolean(ev.success), command: String(ev.command ?? ""), output: String(ev.output ?? "") };
    }
  }
  const manifest = existsSync(manifestPath(workdir, id))
    ? (JSON.parse(readFileSync(manifestPath(workdir, id), "utf8")) as { model?: string; provider?: string; buildCmd?: string | null; steps?: number; maxSteps?: number; usage?: SessionFile["usage"] })
    : {};
  return {
    id,
    createdAt,
    updatedAt,
    task,
    model: manifest.model ?? "",
    provider: manifest.provider ?? "",
    buildCmd: manifest.buildCmd ?? null,
    steps: manifest.steps ?? 0,
    maxSteps: manifest.maxSteps ?? 0,
    messages,
    lastBuild,
    usage: manifest.usage,
  };
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

  // v2 event-sourced sessions (directories with manifest.json), newest first
  const v2: Array<{ id: string; task: string; steps: number; updatedAt: string }> = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const mf = join(dir, e.name, "manifest.json");
    if (!existsSync(mf)) continue;
    try {
      const m = JSON.parse(readFileSync(mf, "utf8")) as {
        id: string; task: string; steps: number; updatedAt: string;
      };
      v2.push({ id: m.id, task: (m.task ?? "").slice(0, 60), steps: m.steps ?? 0, updatedAt: m.updatedAt ?? "" });
    } catch {
      // skip malformed
    }
  }
  v2.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  out.push(...v2);

  // v1 JSON snapshots (legacy, read-only)
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
 * v2: removes the session DIRECTORY (events+manifest). v1: removes the .json.
 * Completed sessions (finished.success) are removed; sessions that did NOT
 * finish successfully are kept longer — they may still be worth resuming.
 * Returns count removed.
 */
export function pruneSessions(workdir: string, days = 7): number {
  const dir = sessionsDir(workdir);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    try {
      const st = statSync(full);
      if (st.mtimeMs >= cutoff) continue;
      if (e.isDirectory()) {
        // v2 session dir — check manifest for finished status
        const mf = join(full, "manifest.json");
        let completed = false;
        if (existsSync(mf)) {
          try {
            completed = JSON.parse(readFileSync(mf, "utf8")).finished?.success === true;
          } catch { completed = false; }
        }
        if (completed) {
          rmSync(full, { recursive: true, force: true });
          removed++;
        }
        continue;
      }
      if (!e.name.endsWith(".json")) continue;
      const s = JSON.parse(readFileSync(full, "utf8")) as SessionFile;
      const completed = s.lastBuild?.success === true;
      if (completed) {
        rmSync(full);
        removed++;
      }
    } catch {
      // malformed JSON — prune it (unreadable session is worthless)
      try { rmSync(full, { recursive: true, force: true }); removed++; } catch { /* ignore */ }
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
