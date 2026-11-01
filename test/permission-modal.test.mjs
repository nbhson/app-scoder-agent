/**
 * T3: PermissionModal — full diff render + scroll + 3 lựa chọn.
 * Modal là React component (không test trực tiếp không ink) — test logic:
 * (1) permissions pass diff đầy đủ qua promptHandler, (2) answer always → session allow,
 * (3) window slice logic qua pure helper.
 * Chạy: node --test test/permission-modal.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionChecker } from "../dist/permissions.js";

const base = { mode: "ask", allowCommands: [], denyCommands: [], nonInteractive: false };

describe("T3 — confirmEdit diff qua promptHandler", () => {
  it("diff dài → truyền nguyên (không cắt 12 dòng), cap 4000 chars", async () => {
    const c = new PermissionChecker(base);
    let seen;
    c.promptHandler = async (req) => {
      seen = req;
      return "yes";
    };
    const diff = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join("\n");
    const ok = await c.confirmEdit("src/a.ts", diff);
    assert.equal(ok, true);
    assert.ok(seen.diff.includes("line 199"), "diff đầy đủ tới cuối (cap 4000 chars không cắt 12 dòng)");
    assert.ok(seen.diff.length <= 4100, `cap 4000 chars: ${seen.diff.length}`);
  });

  it("answer 'always' (edit) → allowAllEdits: call sau không hỏi", async () => {
    const c = new PermissionChecker(base);
    let asks = 0;
    c.promptHandler = async () => {
      asks++;
      return "always";
    };
    await c.confirmEdit("src/a.ts", "+x");
    const ok2 = await c.confirmEdit("src/b.ts", "+y");
    assert.equal(ok2, true);
    assert.equal(asks, 1, "lần 2 không hỏi nữa");
  });

  it("answer 'no' → false", async () => {
    const c = new PermissionChecker(base);
    c.promptHandler = async () => "no";
    assert.equal(await c.confirmEdit("src/a.ts", "+x"), false);
  });

  it("timeout → deny (handler treo, checker-level timeout)", async () => {
    const c = new PermissionChecker(base);
    c.promptHandler = () => new Promise(() => {});
    const ok = await c.confirmEdit("src/a.ts", "+x", 1);
    assert.equal(ok, false, "timeout 1s ⇒ deny");
  });
});
