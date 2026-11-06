/**
 * Pure selectors/estimators over the TUI transcript model (Phase 5.4).
 * Extracted verbatim from state.ts — no behavior change.
 */
import type { ChatItem } from "./state.js";

/**
 * T4: ước lượng chiều cao (rows) của một ChatItem khi render — dùng cho
 * virtualization (chỉ render window quanh viewport thay vì cap cứng).
 * Over-estimate nhẹ an toàn hơn under-estimate (viewport luôn đủ phủ).
 * ponytail: heuristic theo chars, không đo Ink thật — nâng cấp thành đo
 * height thật (useBoxMetrics per item) khi heuristic lệch đáng kể.
 */
export function estimateItemRows(item: ChatItem): number {
  switch (item.kind) {
    case "user":
      return 2 + Math.ceil(item.text.length / 80);
    case "assistant":
    case "thinking":
      return 1 + Math.ceil((item.text?.length ?? 0) / 80) + (item.text ? item.text.split("\n").length : 0);
    case "tool":
      return 1 + 2; // title + preview 2 lines
    case "compaction":
      return 1;
    case "diff":
      return 3 + Math.min(24, (item.text?.split("\n").length ?? 0)); // header + ≤24 lines + border
    case "todo":
      return 2 + item.items.length;
    case "build":
      return 1;
    case "notice":
      return 1 + Math.ceil(item.text.length / 2000);
  }
}

/**
 * T4: chọn window item để render: lấy từ cuối lên tới khi tổng rows ước
 * lượng ≥ viewportRows + margin (render dư phía trên để scroll mượt), nhưng
 * giữ toàn bộ khi tổng nhỏ. Trả về slice của items (không mutate).
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
