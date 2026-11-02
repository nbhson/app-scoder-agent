/**
 * M4: hot-reload — watchWorkdir debounce + skill reload giữa session.
 * Chạy: node --test test/hot-reload.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { watchWorkdir } from "../dist/watch.js";
import { discoverSkills } from "../dist/skills.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("watchWorkdir (M4)", () => {
  it("skill thêm giữa session → onChange('skills') debounce 500ms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m4-"));
    mkdirSync(join(dir, ".scoder", "skills"), { recursive: true });
    const events = [];
    const w = watchWorkdir(dir, (kind) => events.push(kind));
    // Skill layout: <skills>/<name>/SKILL.md
    mkdirSync(join(dir, ".scoder", "skills", "new-skill"), { recursive: true });
    writeFileSync(join(dir, ".scoder", "skills", "new-skill", "SKILL.md"), "---\nname: new-skill\ndescription: test\n---\nbody");
    await sleep(900); // debounce 500 + watch latency
    w.close();
    assert.ok(events.includes("skills"), `events=${JSON.stringify(events)}`);
    // discover lại thấy skill mới
    assert.ok(discoverSkills(dir).some((s) => s.name === "new-skill"));
    rmSync(dir, { recursive: true, force: true });
  });

  it(".scoderrc.json đổi → onChange('config')", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m4c-"));
    writeFileSync(join(dir, ".scoderrc.json"), "{}");
    const events = [];
    const w = watchWorkdir(dir, (kind) => events.push(kind));
    await sleep(100); // đợi watcher setup xong
    writeFileSync(join(dir, ".scoderrc.json"), JSON.stringify({ permissionMode: "ask" }));
    await sleep(900);
    w.close();
    assert.ok(events.includes("config"), `events=${JSON.stringify(events)}`);
    rmSync(dir, { recursive: true, force: true });
  });

  it("debounce: nhiều thay đổi liên tiếp → 1 event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m4d-"));
    mkdirSync(join(dir, ".scoder", "skills"), { recursive: true });
    let count = 0;
    const w = watchWorkdir(dir, () => count++);
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(dir, ".scoder", "skills", `s${i}`), { recursive: true });
      writeFileSync(join(dir, ".scoder", "skills", `s${i}`, "SKILL.md"), "---\nname: s\ndescription: d\n---\nx");
      await sleep(50);
    }
    await sleep(900);
    w.close();
    assert.equal(count, 1, `5 thay đổi liên tiếp phải debounce còn 1 (got ${count})`);
    rmSync(dir, { recursive: true, force: true });
  });
});
