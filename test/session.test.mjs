/**
 * Unit tests cho session.js — SessionStore, prune logic, resolveSessionId.
 * Chạy: node --test test/session.test.mjs (sau khi npm run build)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SessionStore,
  newSessionId,
  listSessions,
  loadSession,
  pruneSessions,
  resolveSessionId,
} from "../dist/session.js";

const TMP = join("/tmp", `coder-session-test-${process.pid}`);

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const sampleData = () => ({
  task: "demo task",
  model: "gpt-4o-mini",
  provider: "openai",
  buildCmd: "npm run build",
  steps: 3,
  maxSteps: 40,
  messages: [{ role: "user", content: "demo" }],
  lastBuild: { success: true, command: "npm run build", output: "ok" },
});

describe("newSessionId", () => {
  it("format YYYYMMDD-HHmmss-hex4, sort theo tên = sort theo thời gian", () => {
    const id = newSessionId(new Date("2026-10-28T10:00:00"));
    assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{4}$/);
  });
  it("id khác nhau giữa các lần gọi (random suffix)", () => {
    const a = new Set();
    for (let i = 0; i < 20; i++) a.add(newSessionId());
    assert.ok(a.size > 1, "20 lần gọi phải tạo >1 id duy nhất");
  });
});

describe("SessionStore", () => {
  it("save + load round-trip với atomic write", () => {
    const store = new SessionStore(TMP, true, "20261028-100000-abcd");
    store.save(sampleData());
    const loaded = loadSession(TMP, "20261028-100000-abcd");
    assert.ok(loaded);
    assert.equal(loaded.task, "demo task");
    assert.equal(loaded.steps, 3);
    assert.equal(loaded.createdAt, loaded.updatedAt);
    // không còn file .tmp sau khi rename
    assert.ok(!existsSync(join(TMP, ".coder/sessions/20261028-100000-abcd.json.tmp")));
  });

  it("save lần 2 giữ nguyên createdAt (dùng param)", () => {
    const store = new SessionStore(TMP, true, "id-1");
    store.save(sampleData(), "2026-01-01T00:00:00Z");
    store.save({ ...sampleData(), steps: 9 }, "2026-01-01T00:00:00Z");
    const loaded = loadSession(TMP, "id-1");
    assert.equal(loaded.createdAt, "2026-01-01T00:00:00Z");
    assert.equal(loaded.steps, 9, "dữ liệu mới nhất được ghi đè");
  });

  it("disabled store -> không ghi file", () => {
    const store = new SessionStore(TMP, false, "id-off");
    store.save(sampleData());
    assert.ok(!existsSync(join(TMP, ".coder/sessions")));
  });

  it("session file hỏng -> loadSession trả null, không crash", () => {
    mkdirSync(join(TMP, ".coder/sessions"), { recursive: true });
    writeFileSync(join(TMP, ".coder/sessions/bad.json"), "{broken");
    assert.equal(loadSession(TMP, "bad"), null);
  });
});

describe("listSessions", () => {
  it("mới nhất trước (reverse sort theo tên)", () => {
    const d = join(TMP, ".coder/sessions");
    mkdirSync(d, { recursive: true });
    const mk = (id, task) =>
      writeFileSync(join(d, `${id}.json`), JSON.stringify({ ...sampleData(), id, task }));
    mk("20261027-100000-aaaa", "older");
    mk("20261028-100000-bbbb", "newer");
    const list = listSessions(TMP);
    assert.equal(list.length, 2);
    assert.equal(list[0].task, "newer");
    assert.equal(list[1].task, "older");
  });

  it("bỏ qua file .jsonl/.tmp và file hỏng", () => {
    const d = join(TMP, ".coder/sessions");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "good.json"), JSON.stringify({ ...sampleData(), id: "good" }));
    writeFileSync(join(d, "x.jsonl"), "{}");
    writeFileSync(join(d, "y.json.tmp"), "{}");
    writeFileSync(join(d, "bad.json"), "{broken");
    const list = listSessions(TMP);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "good");
  });
});

describe("pruneSessions — smart prune", () => {
  const d = () => join(TMP, ".coder/sessions");
  const mk = (name, data, ageDays) => {
    mkdirSync(d(), { recursive: true });
    const p = join(d(), name);
    writeFileSync(p, JSON.stringify(data));
    const old = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
    utimesSync(p, old, old);
  };

  it("xóa session COMPLETED cũ (>7 ngày, lastBuild.success)", () => {
    mk("old-done.json", { ...sampleData(), lastBuild: { success: true, command: "x", output: "" } }, 10);
    assert.equal(pruneSessions(TMP, 7), 1);
    assert.ok(!existsSync(join(d(), "old-done.json")));
  });

  it("GIỮ session chưa hoàn thành cũ (đáng để resume)", () => {
    mk("old-failed.json", { ...sampleData(), lastBuild: { success: false, command: "x", output: "" } }, 10);
    assert.equal(pruneSessions(TMP, 7), 0);
    assert.ok(existsSync(join(d(), "old-failed.json")));
  });

  it("GIỮ session mới (<7 ngày) kể cả completed", () => {
    mk("new-done.json", { ...sampleData(), lastBuild: { success: true, command: "x", output: "" } }, 1);
    assert.equal(pruneSessions(TMP, 7), 0);
    assert.ok(existsSync(join(d(), "new-done.json")));
  });

  it("xóa file JSON hỏng (vô giá trị)", () => {
    mkdirSync(d(), { recursive: true });
    const p = join(d(), "broken.json");
    writeFileSync(p, "{broken");
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    utimesSync(p, old, old);
    assert.equal(pruneSessions(TMP, 7), 1);
    assert.ok(!existsSync(p));
  });

  it("thư mục không tồn tại -> 0, không crash", () => {
    assert.equal(pruneSessions(join(TMP, "nope"), 7), 0);
  });
});

describe("resolveSessionId", () => {
  it("'last' -> session mới nhất", () => {
    const d = join(TMP, ".coder/sessions");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "20261027-100000-aaaa.json"), JSON.stringify({ ...sampleData(), id: "20261027-100000-aaaa" }));
    writeFileSync(join(d, "20261028-100000-bbbb.json"), JSON.stringify({ ...sampleData(), id: "20261028-100000-bbbb" }));
    const s = resolveSessionId(TMP, "last");
    assert.equal(s.id, "20261028-100000-bbbb");
  });

  it("'last' khi không có session -> null", () => {
    assert.equal(resolveSessionId(TMP, "last"), null);
  });

  it("id cụ thể -> load đúng session", () => {
    const d = join(TMP, ".coder/sessions");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "abc.json"), JSON.stringify({ ...sampleData(), id: "abc", task: "specific" }));
    const s = resolveSessionId(TMP, "abc");
    assert.equal(s.task, "specific");
  });

  it("id không tồn tại -> null", () => {
    assert.equal(resolveSessionId(TMP, "ghost"), null);
  });
});
