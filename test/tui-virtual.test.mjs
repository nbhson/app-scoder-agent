/**
 * T4: virtualization helpers — estimateItemRows + visibleWindow.
 * Chạy: node --test test/tui-virtual.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateItemRows, visibleWindow } from "../dist/tui/state.js";

const u = (text) => ({ kind: "user", text });
const tool = (name = "run_command") => ({ kind: "tool", name, args: {}, output: "", ok: null, step: 1 });

describe("estimateItemRows (T4)", () => {
  it("user: 2 + wrap theo chars", () => {
    assert.equal(estimateItemRows(u("hi")), 3); // 2 + ceil(2/80)=1
    assert.equal(estimateItemRows(u("x".repeat(161))), 5); // 2 + ceil(161/80)=3
  });

  it("tool: 3 (title + 2 preview)", () => {
    assert.equal(estimateItemRows(tool()), 3);
  });

  it("diff: 3 + min(24, lines)", () => {
    const d = { kind: "diff", path: "a", added: 1, removed: 0, text: "+a\n+b", truncated: false, step: 1 };
    assert.equal(estimateItemRows(d), 5);
  });
});

describe("visibleWindow (T4)", () => {
  it("ít item → trả nguyên list (không slice)", () => {
    const items = [u("a"), u("b"), u("c")];
    assert.equal(visibleWindow(items, 24), items);
  });

  it("nhiều item cao → chỉ window cuối", () => {
    const items = Array.from({ length: 300 }, (_, i) => u(`msg ${i} ${"x".repeat(100)}`));
    const win = visibleWindow(items, 20);
    assert.ok(win.length < items.length, `win=${win.length} < 300`);
    assert.ok(items.includes(win[win.length - 1]), "phần tử cuối nằm trong window");
    // window phủ đủ viewport + margin (mỗi item ~4 rows → ~70/300 item cuối)
    assert.ok(win.length >= 10);
  });

  it("window cuối đảm bảo phủ viewportRows rows ước lượng", () => {
    const items = Array.from({ length: 500 }, () => tool());
    const win = visibleWindow(items, 30);
    const rows = win.reduce((s, it) => s + estimateItemRows(it), 0);
    assert.ok(rows >= 30 + 50 - 3, `rows=${rows} đủ budget 77 (viewport+margin, trừ item cuối vượt)`);
  });
});
