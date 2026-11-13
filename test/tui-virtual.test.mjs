/**
 * T4: virtualization helpers — estimateItemRows + visibleWindow.
 * Chạy: node --test test/tui-virtual.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateItemRows, visibleWindow, transcriptWindow, estimateTotalRows } from "../dist/tui/state.js";

const u = (text) => ({ kind: "user", text });
const tool = (name = "run_command") => ({ kind: "tool", name, args: {}, output: "", ok: null, step: 1 });

describe("estimateItemRows (T4)", () => {
  it("user: 2 + wrap theo 60 cols", () => {
    assert.equal(estimateItemRows(u("hi")), 3); // 2 + 1
    assert.equal(estimateItemRows(u("x".repeat(161))), 5); // 2 + ceil(161/60)=3
  });

  it("tool: 3 (title + 2 preview)", () => {
    assert.equal(estimateItemRows(tool()), 3);
  });

  it("diff: 3 + min(24, lines)", () => {
    const d = { kind: "diff", path: "a", added: 1, removed: 0, text: "+a\n+b", truncated: false, step: 1 };
    assert.equal(estimateItemRows(d), 5);
  });

  it("notice: tính theo dòng thật (/help 40 dòng không còn bị tính 1 dòng)", () => {
    const n40 = { kind: "notice", level: "info", text: Array.from({ length: 40 }, (_, i) => `/cmd${i} desc`).join("\n") };
    assert.equal(estimateItemRows(n40), 41); // +1 marginTop
    assert.equal(estimateItemRows({ kind: "notice", level: "info", text: "one liner" }), 2);
  });

  it("build: 3, compaction: 2 (marginTop + nội dung)", () => {
    assert.equal(estimateItemRows({ kind: "build", ok: true, success: true, command: "npm run build", durationMs: 10, exitCode: 0 }), 3);
    assert.equal(estimateItemRows({ kind: "compaction", tokensBefore: 10, tokensAfter: 5, manual: false }), 2);
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

describe("transcriptWindow (P1-8)", () => {
  const rowsOf = (items) => items.reduce((s, it) => s + estimateItemRows(it), 0);

  it("transcript ngắn hơn viewport → mount tất cả, offset 0", () => {
    const items = [u("a"), u("b"), tool()];
    const w = transcriptWindow(items, 0, 30);
    assert.deepEqual({ start: w.start, end: w.end, offset: w.offset }, { start: 0, end: items.length, offset: 0 });
    assert.equal(w.totalRows, rowsOf(items));
  });

  it("transcript dài → chỉ window quanh scrollTop, nhỏ hơn cả list", () => {
    const items = Array.from({ length: 300 }, (_, i) => u(`msg ${i} ${"x".repeat(100)}`)); // ~4 rows/item
    const total = estimateTotalRows(items);
    // Cuộn xuống ĐÁY (top = total - viewport): item cuối phải được mount, đa số ẩn.
    const w = transcriptWindow(items, total - 30, 30);
    assert.equal(w.end, items.length, "cuối transcript luôn được mount khi cuộn xuống đáy");
    assert.ok(w.start > 100, `start=${w.start} — hơn 2/3 item bị ẩn`);
    assert.ok(w.end - w.start < 120, `window=${w.end - w.start} item, không mount 300`);
    // Cuộn lên ĐẦU (top = 0): item đầu được mount, item cuối ẩn.
    const t = transcriptWindow(items, 0, 30);
    assert.equal(t.start, 0);
    assert.ok(t.end < items.length, "không mount toàn bộ khi ở đầu");
  });

  it("offset + startRow đúng bằng scrollTop cho mọi vị trí scroll", () => {
    const items = Array.from({ length: 200 }, (_, i) => u(`m${i} ${"y".repeat(120)}`));
    const total = estimateTotalRows(items);
    for (const top of [0, 50, 300, total - 30, total]) {
      const w = transcriptWindow(items, top, 30);
      const hiddenRows = rowsOf(items.slice(0, w.start));
      const clamped = Math.max(0, Math.min(top, total));
      assert.equal(hiddenRows + w.offset, clamped, `top=${top}: offset=${w.offset} + ẩn=${hiddenRows}`);
      assert.ok(w.start < w.end && w.end <= items.length, `window hợp lệ [${w.start},${w.end})`);
    }
  });

  it("item khổng lồ (1 item > viewport+overscan) vẫn được mount", () => {
    const huge = { kind: "assistant", text: "z".repeat(400 * 80), streaming: false };
    const items = [huge, tool()];
    const w = transcriptWindow(items, 0, 30);
    assert.equal(w.start, 0);
    assert.ok(w.end >= 1, "không trả window rỗng");
  });

  it("estimateTotalRows = tổng estimateItemRows (cache không đổi kết quả)", () => {
    const items = [u("a"), tool(), { kind: "notice", text: "n", level: "info" }];
    assert.equal(estimateTotalRows(items), rowsOf(items));
  });
});
