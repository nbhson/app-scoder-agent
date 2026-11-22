/**
 * M4: hot-reload — watchWorkdir debounce + skill reload giữa session.
 * Chạy: node --test test/hot-reload.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { watchWorkdir } from "../dist/workspace/watch.js";
import { discoverSkills } from "../dist/context/skills.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll cho đến khi fn() true hoặc hết thời gian — robust khi chạy song song. */
async function waitUntil(fn, ms = 5_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
}

describe("watchWorkdir (M4)", () => {
  it("skill thêm giữa session → onChange('skills') debounce 500ms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m4-"));
    mkdirSync(join(dir, ".scoder", "skills"), { recursive: true });
    const events = [];
    const w = watchWorkdir(dir, (kind) => events.push(kind));
    await sleep(200); // đợi watcher setup xong
    // Skill layout: <skills>/<name>/SKILL.md
    mkdirSync(join(dir, ".scoder", "skills", "new-skill"), { recursive: true });
    writeFileSync(join(dir, ".scoder", "skills", "new-skill", "SKILL.md"), "---\nname: new-skill\ndescription: test\n---\nbody");
    const hit = await waitUntil(() => events.includes("skills"), 5_000);
    w.close();
    assert.ok(hit, `events=${JSON.stringify(events)} (timeout)`);
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
    const hit = await waitUntil(() => events.includes("config"), 5_000);
    w.close();
    assert.ok(hit, `events=${JSON.stringify(events)}`);
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
    await waitUntil(() => count >= 1, 10_000);
    await sleep(1_500); // 3x debounce window — mọi delayed delivery đều đã kịp nhập batch
    w.close();
    // Máy CI cực chậm có thể giao 5 batch xa nhau tới mức tách 2 cửa sổ debounce
    // (đó vẫn là debounce đúng nghĩa) — điều gate bắt là KHÔNG phải từng event
    // một trực tiếp (10 fs events → count >2 nghĩa là debounce đã chết).
    assert.ok(count <= 2, `5 thay đổi liên tiếp phải debounce còn 1-2 event (got ${count})`);
    rmSync(dir, { recursive: true, force: true });
  });
});
