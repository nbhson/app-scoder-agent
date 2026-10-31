/**
 * Unit tests cho EventSessionStore (session v2 — durable event log).
 * Chạy: node --test test/session-v2.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSessionStore, readEventLog, loadSession, listSessions, pruneSessions } from "../dist/session.js";

/** @type {string} */
let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "scoder-store-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("EventSessionStore — append + projection", () => {
  it("run.started + message.added project into messages", () => {
    const s = new EventSessionStore(workdir, true);
    s.append({ type: "run.started", task: "fix the bug" });
    s.append({ type: "message.added", message: { role: "user", content: "fix the bug" } });
    s.append({ type: "message.added", message: { role: "assistant", content: "on it" } });
    assert.equal(s.messages.length, 2);
    assert.equal(s.messages[1].role, "assistant");
    const sf = s.toSessionFile();
    assert.equal(sf.task, "fix the bug");
    assert.equal(sf.messages.length, 2);
  });

  it("events.jsonl is durable JSONL with seq + ts + v", () => {
    const s = new EventSessionStore(workdir, true);
    s.append({ type: "run.started", task: "t1" });
    s.append({ type: "finish", success: true, summary: "done" });
    const raw = readFileSync(join(workdir, ".scoder", "sessions", s.id, "events.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.equal(e1.v, 1);
    assert.ok(e1.ts);
    assert.equal(e1.type, "run.started");
  });

  it("disabled store writes nothing", () => {
    const s = new EventSessionStore(workdir, false);
    s.append({ type: "run.started", task: "t" });
    assert.ok(!existsSync(join(workdir, ".scoder", "sessions", s.id)));
  });

  it("build.checked projects into lastBuild", () => {
    const s = new EventSessionStore(workdir, true);
    s.append({ type: "build.checked", success: true, command: "npm test", output: "ok\n" });
    assert.equal(s.toSessionFile().lastBuild?.success, true);
  });

  it("claim/release tracked; stale claim detectable", () => {
    const s1 = new EventSessionStore(workdir, true);
    s1.claimExecution(1);
    s1.releaseExecution(1);
    assert.equal(EventSessionStore.hasStaleClaim(workdir, s1.id), false);

    const s2 = new EventSessionStore(workdir, true);
    s2.claimExecution(1);
    assert.equal(EventSessionStore.hasStaleClaim(workdir, s2.id), true, "claimed without release = stale");
  });

  it("malformed line (torn write) skipped — remaining lines valid", () => {
    const s = new EventSessionStore(workdir, true);
    s.append({ type: "run.started", task: "a" });
    s.append({ type: "finish", success: true, summary: "b" });
    const p = join(workdir, ".scoder", "sessions", s.id, "events.jsonl");
    const lines = readFileSync(p, "utf8").trim().split("\n");
    // simulate torn write between line 1 and 2
    const corrupted = lines[0] + "\n{\"ts\":\"x\",\"type\":\"messa\n" + lines[1] + "\n";
    writeFileSync(p, corrupted);
    const events = readEventLog(workdir, s.id);
    assert.equal(events.length, 2, "torn line dropped, valid lines survive");
  });
});

describe("sessionFromEventLog / loadSession / listSessions — v2 read path", () => {
  it("loadSession reads a v2 session directory", () => {
    const s = new EventSessionStore(workdir, true);
    s.append({ type: "run.started", task: "task-x" });
    s.append({ type: "message.added", message: { role: "user", content: "go" } });
    s.writeManifest({ task: "task-x", model: "m", provider: "openai", buildCmd: "make", steps: 3, maxSteps: 10 });
    const sf = loadSession(workdir, s.id);
    assert.ok(sf, "v2 session must load");
    assert.equal(sf.task, "task-x");
    assert.equal(sf.model, "m");
    assert.equal(sf.steps, 3);
    assert.equal(sf.messages.length, 1);
  });

  it("listSessions includes v2 + orders newest first", async () => {
    const s1 = new EventSessionStore(workdir, true);
    s1.append({ type: "run.started", task: "older" });
    s1.writeManifest({ task: "older", model: "m", provider: "p", buildCmd: null, steps: 1, maxSteps: 5 });
    // Ensure distinct updatedAt timestamps (same-ms writes race the sort).
    await new Promise((r) => setTimeout(r, 10));
    const s2 = new EventSessionStore(workdir, true);
    s2.append({ type: "run.started", task: "newer" });
    s2.writeManifest({ task: "newer", model: "m", provider: "p", buildCmd: null, steps: 2, maxSteps: 5 });
    const all = listSessions(workdir);
    assert.equal(all.length, 2);
    assert.equal(all[0].id, s2.id, "newest first");
    assert.equal(all[0].task, "newer");
  });

  it("pruneSessions removes finished v2 sessions past cutoff, keeps unfinished", () => {
    const done = new EventSessionStore(workdir, true);
    done.append({ type: "run.started", task: "done-task" });
    done.append({ type: "finish", success: true, summary: "ok" });
    done.writeManifest({ task: "done-task", model: "m", provider: "p", buildCmd: null, steps: 1, maxSteps: 5 });

    const stuck = new EventSessionStore(workdir, true);
    stuck.append({ type: "run.started", task: "stuck-task" });
    stuck.writeManifest({ task: "stuck-task", model: "m", provider: "p", buildCmd: null, steps: 2, maxSteps: 5 });

    // Backdate both session dirs beyond cutoff (utimesSync accepts Date).
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(join(workdir, ".scoder", "sessions", done.id), old, old);
    utimesSync(join(workdir, ".scoder", "sessions", stuck.id), old, old);

    const removed = pruneSessions(workdir, 7);
    assert.equal(removed, 1);
    assert.ok(!existsSync(join(workdir, ".scoder", "sessions", done.id)), "finished pruned");
    assert.ok(existsSync(join(workdir, ".scoder", "sessions", stuck.id)), "unfinished kept");
  });
});
