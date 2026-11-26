/**
 * Chữ ký chuẩn hoá của tool call — nền cho cả bộ đếm doom-loop lẫn cache chống
 * lặp trong run-loop.
 *
 * Lý do tồn tại: detector cũ so chuỗi `arguments` NGUYÊN VĂN
 * (`${tc.name}:${tc.arguments}`). Model local (llama.cpp / Ollama) tái serialize
 * JSON không ổn định — thứ tự key, khoảng trắng sau `:`, escape — nên hai lệnh
 * THỰC CHẤT GIỐNG HỆT nhau bị coi là khác nhau và bộ đếm lặp không bao giờ chạy.
 * Ở đây args được parse rồi stringify với key đã sắp xếp, nên "lệch hình thức"
 * không còn qua mặt được detector; JSON hỏng thì fallback chuẩn hoá khoảng trắng.
 *
 * Module thuần, không phụ thuộc gì ngoài type — dùng được từ cả agent/ và llm/.
 */
import type { ToolCall } from "../llm/llm.js";

/** Depth cap cho stableStringify — chống đệ quy vô hạn trên args tự tham chiếu. */
const MAX_DEPTH = 6;
/** Chữ ký dài hơn mức này được rút gọn (prefix + hash) để làm khoá map rẻ hơn. */
const SIG_INLINE_LIMIT = 96;
/** Cửa sổ chữ ký batch giữ lại để phát hiện chu kỳ lặp. */
export const SIG_WINDOW = 16;

/** Serialize ổn định: key sắp xếp theo thứ tự từ điển, whitespace không đổi. */
function stableStringify(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) return '"…"';
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, depth + 1)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], depth + 1)}`).join(",")}}`;
}

/** FNV-1a 32-bit → hex. Đủ phân biệt cho khoá intra-run, không cần crypto. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Args → dạng chuẩn để so sánh. JSON hợp lệ thì stable-stringify; JSON hỏng thì
 * collapse khoảng trắng (vẫn bắt được lặp kiểu "command": "npm  test").
 */
export function normalizeToolArgs(raw: string | undefined | null): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  try {
    return stableStringify(JSON.parse(text), 0);
  } catch {
    return text.replace(/\s+/g, " ").toLowerCase();
  }
}

/** Rút gọn chữ ký dài (write_file nguyên văn cả file) vẫn giữ tính duy nhất. */
function compact(sig: string): string {
  if (sig.length <= SIG_INLINE_LIMIT) return sig;
  return `${sig.slice(0, 48)}#${fnv1a(sig)}`;
}

/** "read_file{\"path\":\"a.ts\"}" — chuẩn hoá, không phụ thuộc cách model in JSON. */
export function callSignature(name: string, rawArgs: string | undefined | null): string {
  return compact(`${name}:${normalizeToolArgs(rawArgs)}`);
}

/**
 * Chữ ký cả batch tool call của một bước. `id` bị loại vì mock/provider sinh id
 * khác nhau cho cùng một lệnh — lặp vẫn phải được nhận ra.
 */
export function batchSignature(calls: readonly ToolCall[]): string {
  return compact(
    calls
      .map((tc) => callSignature(tc.name, tc.arguments))
      .sort()
      .join("|"),
  );
}

/**
 * Tool thuần đọc — cùng args thì cùng kết quả, nên gọi lặp lại là vô nghĩa.
 * Dùng cho hai việc: chạy song song an toàn (I-09) và cache chống lặp.
 * Tool biến đổi (write/edit/patch/run_command) KHÔNG ở đây: lệnh build lặp lại
 * là vòng verify–fix hợp lệ, không phải doom-loop.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_files",
  "grep",
  "glob",
  "load_skill",
  "repo_map",
  "web_fetch",
  "diagram_focus",
]);
