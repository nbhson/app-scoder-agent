/**
 * Pure selectors/estimators over the TUI transcript model (Phase 5.4).
 * Extracted verbatim from state.ts — no behavior change.
 */
import type { ChatItem } from "./state.js";
import { parseMarkdown } from "./markdown/parse.js";
import { measure } from "./text-width.js";

const EST_WIDTH = 80;

/** Ước lượng số dòng wrap của một đoạn text ở width cho trước. */
function wrapEstimate(text: string, width: number): number {
  return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(measure(line) / width)), 0);
}

/**
 * Block-aware estimate cho assistant message: parse markdown rồi cộng chiều
 * cao từng block. Chính xác hơn nhiều so với heuristic len/80 cũ — bảng (+3
 * viền), code box (+2 viền + gutter wrap), mermaid (~14 dòng) trước đây làm
 * virtualization window lệch lớn.
 */
export function estimateMarkdownRows(text: string, width = EST_WIDTH): number {
  if (!text) return 1;
  let rows = 0;
  for (const block of parseMarkdown(text)) {
    switch (block.kind) {
      case "paragraph":
        rows += wrapEstimate(block.text, width);
        break;
      case "heading":
      case "hr":
      case "spacer":
        rows += 1;
        break;
      case "code": {
        const gutter = String(Math.min(block.lines.length, 60)).length;
        const codeWidth = Math.max(8, width - gutter - 6);
        const shown = Math.min(block.lines.length, 60);
        rows += wrapEstimate(block.lines.slice(0, shown).join("\n"), codeWidth)
          + 2 // border top/bottom
          + (block.lang ? 1 : 0)
          + (block.lines.length > 60 ? 1 : 0)
          + 1; // marginTop
        break;
      }
      case "table":
        // top + header + separator + rows + bottom (+ cap note) + margin
        rows += Math.min(block.rows.length, 50) + 4 + (block.rows.length > 50 ? 1 : 0) + 1;
        break;
      case "list":
        rows += block.items.reduce((sum, it) => sum + wrapEstimate(it.text, Math.max(8, width - 4 - it.depth * 2)), 0);
        break;
      case "quote":
        rows += wrapEstimate(block.text, Math.max(8, width - 2));
        break;
      case "mermaid":
        // summary box: ~4 header lines + ≤6 nodes + ≤8 edges + hint + 2 border
        rows += Math.min(block.lines.length, 12) + 6;
        break;
      case "chart":
        rows += 2 + 40 + 1; // ContentBox max: borders + ≤40 data rows
        break;
      case "timeline":
        rows += 1 + block.source.split("\n").length * 2;
        break;
    }
  }
  return rows;
}

/**
 * T4: ước lượng chiều cao (rows) của một ChatItem khi render — dùng cho
 * virtualization (chỉ render window quanh viewport thay vì cap cứng).
 * Over-estimate nhẹ an toàn hơn under-estimate (viewport luôn đủ phủ).
 * Assistant items dùng estimateMarkdownRows (block-aware); các kind khác giữ
 * heuristic đơn giản vì render gần như 1:1 với text.
 */
export function estimateItemRows(item: ChatItem): number {
  switch (item.kind) {
    case "user":
      // Render: marginTop 1 + border-left box paddingX 1, wrap theo chat width
      // (~60–96 cột). 60 là giả định hẹp an toàn (over-estimate nhẹ).
      return 2 + wrapEstimate(item.text ?? "", 60);
    case "assistant":
      // +1 marginTop; streaming raw text dùng wrap đơn giản (chưa qua markdown).
      return item.streaming
        ? (item.text ? 1 : 0) + wrapEstimate(item.text ?? "", 76)
        : 1 + estimateMarkdownRows(item.text ?? "", EST_WIDTH);
    case "thinking":
      // Render: collapse to last 4 lines.
      return 1 + Math.min(4, item.text ? item.text.split("\n").length : 0);
    case "tool":
      return 1 + 2; // title + preview 2 lines
    case "compaction":
      return 2; // marginTop + divider
    case "diff":
      return 3 + Math.min(24, (item.text?.split("\n").length ?? 0)); // header + ≤24 lines + border
    case "todo":
      // TodoItemView render null (plan hiển thị ở sidebar qua state.plan) —
      // chiếm 0 dòng thực tế trong transcript.
      return 0;
    case "build":
      return 3; // marginTop + label + command
    case "notice":
      // Render raw text (cap 2000 chars) với wrap thật theo width — /help là
      // notice 40 dòng; estimate cũ (1 + len/2000) under-estimate khiến
      // follow-bottom clip dòng kế tiếp ( regression caught by tui.test E2E).
      return 1 + wrapEstimate(item.text.length > 2000 ? item.text.slice(0, 2000) + "…" : item.text, 76);
  }
}

/**
 * T4: chọn window item để render: lấy từ cuối lên tới khi tổng rows ước
 * lượng ≥ viewportRows + margin (render dư phía trên để scroll mượt), nhưng
 * giữ toàn bộ khi tổng nhỏ. Trả về slice của items (không rẻ — dùng
 * transcriptWindow cho scroll đúng offset, hàm này chỉ còn cho callers cũ).
 */
export function visibleWindow(
  items: ChatItem[],
  viewportRows: number,
  margin = 50,
): ChatItem[] {
  const budget = viewportRows + margin;
  let acc = 0;
  let start = items.length;
  while (start > 0 && acc < budget) {
    start--;
    acc += estimateItemRows(items[start]);
  }
  return start === 0 ? items : items.slice(start);
}

// P1-8: cache số dòng ước lượng theo IDENTITY của item. state.ts patch item
// kiểu immutable (object mới khi nội dung đổi) ⇒ item finalized không bao giờ
// tính lại; chỉ item đang stream (mỗi flush đổi reference) mới estimate lại.
const itemRowsCache = new WeakMap<ChatItem, number>();
function itemRowsCached(item: ChatItem): number {
  const hit = itemRowsCache.get(item);
  if (hit !== undefined) return hit;
  const v = estimateItemRows(item);
  itemRowsCache.set(item, v);
  return v;
}

/** Tổng chiều cao ước lượng của cả transcript — O(n) phép cộng số nhỏ. */
export function estimateTotalRows(items: ChatItem[]): number {
  let acc = 0;
  for (const it of items) acc += itemRowsCached(it);
  return acc;
}

export interface TranscriptWindow {
  /** Index tuyệt đối item đầu được mount. */
  start: number;
  /** Index tuyệt đối sau-cuối được mount (exclusive). */
  end: number;
  /** Rows phải ẩn ở ĐẦU content đã mount = scrollTop - startRow[start]. */
  offset: number;
  /** Tổng chiều cao ước lượng của CẢ transcript (thay cho content.height đo thật). */
  totalRows: number;
}

/**
 * P1-8 — virtualization cho transcript viewport. Mount duy các item phủ
 * [scrollTop - overscan, scrollTop + viewportRows + overscan] thay vì cả
 * transcript: chi phí React diff + Yoga layout + wrap mỗi frame hết tỷ lệ
 * với tổng số text (đo: 42–53 ms/frame ở 300–400 item → ~7 ms khi window).
 * Scroll dùng ước lượng rows (estimateItemRows, cache theo identity item),
 * nên khi estimate lệch thực tế thì offset chỉ sai vài dòng — cùng trade-off
 * mọi TUI virtualized dùng.
 */
export function transcriptWindow(
  items: ChatItem[],
  scrollTop: number,
  viewportRows: number,
  overscan = 24,
): TranscriptWindow {
  const n = items.length;
  // Cumulative start rows một lượt O(n) nhưng chỉ là phép cộng số nhỏ.
  const startRow = new Array<number>(n + 1);
  startRow[0] = 0;
  for (let i = 0; i < n; i++) startRow[i + 1] = startRow[i] + itemRowsCached(items[i]);
  const totalRows = startRow[n];

  const top = Math.max(0, Math.min(scrollTop, totalRows));
  const target = Math.max(0, top - overscan);
  let start = 0;
  while (start + 1 < n && startRow[start + 1] <= target) start++;
  const bottomTarget = top + viewportRows + overscan;
  let end = start;
  while (end < n && startRow[end] < bottomTarget) end++;
  if (end === start && start < n) end = start + 1; // item khổng lồ vẫn phải hiện
  return { start, end, offset: top - startRow[start], totalRows };
}

/**
 * Plan mới nhất cho sidebar — todo items được append mỗi lần update nhưng
 * sidebar chỉ cần snapshot hiện tại (last-wins), null khi chưa có plan.
 *
 * Reset realtime: mỗi lần user gửi message mới, plan reset — chỉ hiện plan
 * được viết SAU user message cuối cùng. Tránh stale plan từ task trước hiện
 * trong task mới.
 */
export function latestPlan(items: ChatItem[]): Extract<ChatItem, { kind: "todo" }> | null {
  // Tìm user message cuối cùng — plan chỉ reset tại đây.
  let lastUserIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user") { lastUserIdx = i; break; }
  }
  // Chỉ tìm todo SAU user cuối.
  for (let i = items.length - 1; i > lastUserIdx; i--) {
    if (items[i].kind === "todo") return items[i] as Extract<ChatItem, { kind: "todo" }>;
  }
  return null;
}

/**
 * Map tên tool → phase của breadcrumb (plan→explore→edit→build→verify).
 * Trả về null với tool không thuộc phase nào (mcp__*...).
 */
export function toolPhase(name: string): string | null {
  if (name === "write_todos") return "plan";
  if (name === "list_files" || name === "read_file" || name === "grep" || name === "glob" || name === "web_fetch" || name === "load_skill" || name === "repo_map") return "explore";
  if (name === "write_file" || name === "edit_file" || name === "apply_patch") return "edit";
  if (name === "run_command") return "build";
  if (name === "task") return "delegate";
  if (name === "ask_user") return "clear";
  if (name.startsWith("mcp__")) return "mcp";
  return null;
}
