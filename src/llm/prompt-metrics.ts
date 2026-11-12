/**
 * P1-3 (RC-1): đo "prefix" của prompt để phát hiện mất KV-cache.
 *
 * Engine cục bộ (llama.cpp / Ollama) chỉ reuse KV cache cho phần prefix GIỐNG
 * HẸT từng token; một token ở giữa đổi ⇒ re-prefill toàn bộ phía sau. Session
 * `20261106-023204-670b` đổi 11.9s → 141.3s/lượt đúng tại điểm prune đầu
 * tiên. Câu hỏi cần trả lời được từ JSONL: "lượt này history có phải là append
 * lên history của lượt trước không?"
 *
 * Cách đo: băm TỪNG message theo thứ tự, so mảng hash của lượt trước với lượt
 * này. `prefixReused = true` khi mảng cũ là tiền tố của mảng mới (append-only)
 * ⇒ toàn bộ prompt đã gửi trước đó vẫn nằm nguyên trong cache. Một message ở
 * giữa bị sửa (prune/trim/compaction) ⇒ false. Đổi tool list cũng làm hỏng
 * prefix (tool defs nằm ở vùng system) nên `promptHash` (gồm cả tools) được log
 * kèm để phân biệt hai nguyên nhân.
 */
import { createHash } from "node:crypto";
import type { ChatMessage, ToolSpec } from "./llm.js";

export interface PromptMetrics {
  messages: number;
  tools: number;
  /** Char thật của cả prompt (message + tool defs). */
  promptChars: number;
  /** Char phần messages (system prompt + repo map + history + task). */
  messageChars: number;
  /** Char phần tool schema — nhân với ~3.5 char/token là ra chi phí cố định. */
  schemaChars: number;
  /** Hash toàn bộ prompt (tools + history) — đổi là prompt khác. */
  promptHash: string;
  /** Hash riêng của phần history (không tính tools). */
  historyHash: string;
  /** Hash từng message — dùng để tính tiền tố chung giữa hai lượt gọi. */
  messageHashes: string[];
  /**
   * `null` = lượt đầu tiên (chưa có gì để so).
   * `true` = history lượt trước là tiền tố của history lượt này → prefix
   * KV-cache còn dùng được.
   * `false` = có message cũ bị sửa/xoá → re-prefill toàn bộ từ điểm đổi.
   */
  prefixReused: boolean | null;
  /** Số message đầu giống hệt lượt trước (để ước lượng độ dài prefix mất). */
  commonPrefixMessages: number | null;
}

const short = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** Chuỗi đặc trưng cho một message (role + content + tool_calls). */
function messageKey(m: ChatMessage): string {
  let s = m.role + "\u0000" + (m.content ?? "");
  for (const tc of m.tool_calls ?? []) {
    const call = tc as unknown as {
      name?: string;
      arguments?: string;
      function?: { name?: string; arguments?: string };
    };
    s += "\u0001" + (call.name ?? call.function?.name ?? "") + (call.arguments ?? call.function?.arguments ?? "");
  }
  if (m.tool_call_id) s += "\u0002" + m.tool_call_id;
  return s;
}

/** Serialize phần tools — đặc trưng và ổn định theo thứ tự khai báo. */
export function serializeTools(tools: ToolSpec[]): string {
  return (tools ?? [])
    .map((t) => t.function.name + "\u0000" + (t.function.description ?? "") + "\u0000" + JSON.stringify(t.function.parameters ?? {}))
    .join("\u0003");
}

export function messageHashes(messages: ChatMessage[]): string[] {
  return (messages ?? []).map((m) => short(messageKey(m)));
}

/**
 * So sánh: mảng hash của lượt trước có phải tiền tố của lượt này không.
 * `commonPrefix` = số message đầu giống nhau.
 */
export function commonPrefixLength(prev: string[] | undefined, current: string[]): {
  reused: boolean;
  commonPrefix: number;
} {
  const previous = prev ?? [];
  let i = 0;
  while (i < previous.length && i < current.length && previous[i] === current[i]) i++;
  return { reused: i === previous.length, commonPrefix: i };
}

/** Tính metrics cho một lượt gọi — O(kích thước prompt), chỉ chạy một lần/lượt. */
export function promptMetrics(
  messages: ChatMessage[],
  tools: ToolSpec[],
  previous?: { messageHashes: string[] } | null,
): PromptMetrics {
  const hashes = messageHashes(messages);
  const historyText = hashes.join("");
  const toolsText = serializeTools(tools);
  const cmp = previous ? commonPrefixLength(previous.messageHashes, hashes) : null;
  // Char thật của prompt (nội dung message + tool defs) — để trả lời "12k token
  // này đến từ đâu". KHÔNG dùng historyText (chuỗi hash) ở đây.
  let messageChars = 0;
  for (const m of messages ?? []) {
    messageChars += (m.content ?? "").length + (m.tool_call_id ?? "").length;
    for (const tc of m.tool_calls ?? []) {
      const call = tc as unknown as {
        name?: string;
        arguments?: string;
        function?: { name?: string; arguments?: string };
      };
      messageChars += (call.name ?? call.function?.name ?? "").length + (call.arguments ?? call.function?.arguments ?? "").length;
    }
  }
  return {
    messages: hashes.length,
    tools: (tools ?? []).length,
    promptChars: messageChars + toolsText.length,
    messageChars,
    schemaChars: toolsText.length,
    promptHash: short(toolsText + "\u0004" + historyText),
    historyHash: short(historyText),
    messageHashes: hashes,
    prefixReused: cmp ? cmp.reused : null,
    commonPrefixMessages: cmp ? cmp.commonPrefix : null,
  };
}
