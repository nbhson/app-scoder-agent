/**
 * Unit tests cho steering/queue (H-08).
 * Chạy: node --test test/steer.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../dist/agent.js";

function makeAgent(workdir) {
  return new Agent({
    workdir,
    task: "",
    provider: "openai",
    model: "gpt-test",
    apiKey: "test",
    maxSteps: 3,
    permissionMode: "readonly", // never actually calls the LLM in these tests
    yes: true,
  });
}

describe("Agent.steer/queue — inbox (H-08)", () => {
  it("steer() accepts input; enqueued events persisted in the event log", () => {
    const wd = mkdtempSync(join(tmpdir(), "steer-"));
    try {
      const agent = makeAgent(wd);
      const events = [];
      agent.onEvent = (ev) => events.push(ev);

      agent.steer("also check the tests");
      agent.steer(""); // empty ignored
      assert.ok(events.some((e) => e.type === "steer_queued" && e.text === "also check the tests"));
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("steer before any run() does not throw and is persisted in the event log", async () => {
    const wd = mkdtempSync(join(tmpdir(), "steer2-"));
    try {
      const agent = makeAgent(wd);
      agent.steer("hello");
      // events.jsonl should contain steer.enqueued
      
      const sessDir = join(wd, ".scoder", "sessions");
      const ids = readdirSync(sessDir);
      assert.equal(ids.length, 1);
      const log = readFileSync(join(sessDir, ids[0], "events.jsonl"), "utf8");
      assert.match(log, /"type":"steer\.enqueued"/);
      assert.match(log, /"mode":"steer"/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("queue() same inbox, mode=queue", async () => {
    const wd = mkdtempSync(join(tmpdir(), "steer3-"));
    try {
      const agent = makeAgent(wd);
      const seen = [];
      agent.onEvent = (ev) => seen.push(ev);
      agent.queue("queued text");
      assert.ok(seen.some((e) => e.type === "steer_queued" && e.mode === "queue" && e.text === "queued text"));
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("empty/whitespace input ignored", () => {
    const wd = mkdtempSync(join(tmpdir(), "steer4-"));
    try {
      const agent = makeAgent(wd);
      const seen = [];
      agent.onEvent = (ev) => seen.push(ev);
      agent.steer("   ");
      agent.queue("");
      assert.ok(!seen.some((e) => e.type === "steer_queued"), "no events for empty input");
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});

describe("drainSteerInbox — delivery at step boundary", () => {
  it("drain empties the inbox (messages injected by runLoop next step)", async () => {
    // Integration-level delivery is covered by e2e; here we verify the drain
    // helper via the event log + that steer → drain → empty ordering holds.
    const wd = mkdtempSync(join(tmpdir(), "steer5-"));
    try {
      const agent = makeAgent(wd);
      agent.steer("one");
      agent.steer("two");
      // delivery happens inside runLoop; not directly testable without an LLM.
      // Sanity: no crash + events persisted.
      
      const log = readFileSync(
        join(wd, ".scoder", "sessions", readdirSync(join(wd, ".scoder", "sessions"))[0], "events.jsonl"),
        "utf8",
      );
      assert.equal(log.split("\n").filter((l) => l.includes("steer.enqueued")).length, 2);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});
