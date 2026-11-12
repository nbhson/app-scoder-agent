/**
 * P0-3 (RC-2): glob filter cho tên tool MCP.
 *
 * Tách khỏi McpManager để `agent/mcp-bridge.ts` lọc được DANH SÁCH TOOL ĐÃ
 * QUẢNG CÁO (tên đầy đủ `mcp__<server>__<tool>`) bằng rc "mcpTools" — cùng cú
 * pháp với `mcpServers.<name>.tools.include/exclude` (lọc theo server).
 */

/** Pattern không có `*` so khớp đúng tên (case-insensitive); có `*` → glob. */
export function matchToolPattern(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (!p.includes("*")) return n === p;
  const rx = new RegExp("^" + p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return rx.test(n);
}

export interface ToolNameFilter {
  include?: string[];
  exclude?: string[];
}

/** True khi `name` được phép theo filter (include rỗng = tất cả; exclude thắng). */
export function toolAllowed(name: string, filter: ToolNameFilter | undefined): boolean {
  if (!filter) return true;
  const include = (filter.include ?? []).filter(Boolean);
  const exclude = (filter.exclude ?? []).filter(Boolean);
  if (include.length > 0 && !include.some((pat) => matchToolPattern(pat, name))) return false;
  if (exclude.some((pat) => matchToolPattern(pat, name))) return false;
  return true;
}

/** Lọc một danh sách theo nhiều filter (giữ thứ tự khai báo). */
export function filterToolNames<T>(items: T[], nameOf: (item: T) => string, filter: ToolNameFilter | undefined): T[] {
  if (!filter || (!filter.include?.length && !filter.exclude?.length)) return items;
  return items.filter((item) => toolAllowed(nameOf(item), filter));
}
