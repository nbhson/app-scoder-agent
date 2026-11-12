import type { ChatMessage } from "../llm/llm.js";
import { encode } from "gpt-tokenizer";
import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

const MAX_MESSAGES = 120; // keep history under control for long runs
/**
 * Default history token budget when compaction is disabled (I-10:
 * token-accurate via gpt-tokenizer, thay char heuristic 100k chars ≈ 25k
 * tokens). Conservative: system prompt + tool defs + reply buffer chiếm phần
 * còn lại của contextWindow.
 */
export const MAX_HISTORY_TOKENS = 90_000;
/**
 * Fraction of the model context window where mechanical trim starts when
 * compaction is enabled. Must stay ABOVE the compaction trigger (default
 * 0.8) so semantic compaction gets a chance to run first.
 */
export const HISTORY_TRIM_FRACTION = 0.95;
/**
 * Mechanical trim budget for a given context window (floor 2k).
 *
 * `fixedTokens` (P1-1/RC-4): phần prompt cố định KHÔNG nằm trong messages —
 * quan trọng nhất là tool schema (~16k token với 46 tool MCP). `outputReserve`:
 * chỗ trống cho reply (config.maxTokens). Với 1 tham số, hành vi giữ nguyên
 * như trước (chỉ scale theo window) để tương thích test và rollback.
 */
export function historyTokenBudget(contextWindow: number, fixedTokens = 0, outputReserve = 0): number {
  return Math.max(2_000, Math.floor(contextWindow * HISTORY_TRIM_FRACTION - fixedTokens - outputReserve));
}
/**
 * P0-1 (hysteresis): khi trim đã cần thiết, cắt xuống còn fraction này của
 * ngân sách thay vì đúng ngưỡng. Mỗi lần trim đều vô hiệu hoá KV-cache của
 * toàn bộ prompt phía sau điểm cắt (llama.cpp/Ollama chỉ reuse prefix giống
 * hệt từng token), nên mục tiêu là THỨA NHẤT trim, không phải trim "vừa đủ".
 */
export const TRIM_RECOVERY_FRACTION = 0.7;
/** Tool results older than this many recent tool messages get pruned. */
const KEEP_RECENT_TOOL_RESULTS = 20;
/** Placeholder do prune thay vào — test và UI nhận diện chuỗi này. */
export const PRUNED_TOOL_RESULT = "[pruned — old tool result]";

/** Token count for one message (tool_calls arguments included). Never throws. */
function messageTokens(m: ChatMessage): number {
  let text = m.content ?? "";
  if (m.tool_calls) for (const tc of m.tool_calls) text += tc.name + tc.arguments;
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

const historyTokens = (msgs: ChatMessage[]) => msgs.reduce((n, m) => n + messageTokens(m), 0);

/** Char count (content + tool_call args) — không tokenize. */
function historyChars(msgs: ChatMessage[]): number {
  let chars = 0;
  for (const m of msgs) {
    chars += m.content?.length ?? 0;
    // ChatMessage dùng shape {name, arguments}; history dựng từ JSONL resume có
    // thể mang shape OpenAI {function:{name,arguments}} — đọc cả hai, không crash.
    for (const tc of m.tool_calls ?? []) {
      const call = tc as unknown as {
        name?: string;
        arguments?: string;
        function?: { name?: string; arguments?: string };
      };
      chars +=
        (call.name?.length ?? 0) +
        (call.arguments?.length ?? 0) +
        (call.function?.name?.length ?? 0) +
        (call.function?.arguments?.length ?? 0);
    }
  }
  return chars;
}

/**
 * P0-1: áp lực history so với ngân sách token.
 *
 * Một token luôn dài ≥ 1 ký tự, nên `chars` là cận trên tuyệt đối của số
 * token: nếu chars còn chưa vượt ngân sách thì chắc chắn UNDER — bỏ qua
 * bước encode (O(n) trên toàn bộ history, tránh trả giá mỗi bước).
 * Khi chars vượt ngân sách mới tokenize chính xác.
 */
export function historyPressure(
  messages: ChatMessage[],
  budget: number = MAX_HISTORY_TOKENS,
): { tokens: number; budget: number; over: boolean } {
  const chars = historyChars(messages);
  if (chars <= budget) return { tokens: chars, budget, over: false };
  const tokens = historyTokens(messages);
  return { tokens, budget, over: tokens > budget };
}

/**
 * Trim message history to stay within a token budget. Layered strategy
 * (context engineering — inspired by compaction patterns, from scratch):
 *   0. P0-1 fast path: dưới ngân sách thì TRẢ NGUYÊN MẢNG (identity).
 *   1. Message-count cap: keep system + newest MAX_MESSAGES-1.
 *   2. Old tool results (outside the recent window) are pruned in ONE bulk
 *      pass to a short placeholder — cheapest information loss.
 *   3. Still over target: drop the OLDEST BLOCKS from the head (system được
 *      bảo vệ; điểm cắt không bao giờ nằm sau một assistant có tool_calls)
 *      until under the recovery target.
 *
 * Không bao giờ sửa nội dung lác đác ở giữa prompt: mỗi lần trim là một lần
 * cắt gọn nhất có thể, để THỨA lần trim xảy ra.
 *
 * `maxTokens` defaults to the legacy 90k cap; callers with compaction enabled
 * pass `historyTokenBudget(contextWindow)` so trim runs *after* compaction.
 *
 * PERF CONTRACT (plan/performance-issue.md RC-1): hàm này KHÔNG được gọi mỗi
 * bước. Trước đây nó chạy sau mỗi step và luôn luôn sửa in-place tool result
 * ở giữa prompt (_boundary_ prune list dịch theo từng step) → mọi lượt gọi LLM
 * đều re-prefill toàn bộ history. Session `20261106-023204-670b`: 1.58M input
 * token, `cachedTokens: 0`, latency nhảy từ 11.9s → 141.3s/lượt. Chỉ gọi khi
 * `historyPressure().over` (guardrail `history-trim`) hoặc khi compaction fail.
 */
export function trimHistory(messages: ChatMessage[], maxTokens = MAX_HISTORY_TOKENS): ChatMessage[] {
  // 0) Nothing over budget → trả về đúng mảng được truyền vào. Prefix của
  //    prompt vì thế giữ nguyên từng byte giữa các lượt gọi LLM.
  const overCount = messages.length > MAX_MESSAGES;
  const overTokens = historyPressure(messages, maxTokens).over;
  if (!overCount && !overTokens) return messages;

  const target = Math.max(1, Math.floor(maxTokens * TRIM_RECOVERY_FRACTION));
  let out = messages;

  // 1) Message-count cap
  if (out.length > MAX_MESSAGES) {
    const system = out[0].role === "system" ? out[0] : null;
    const rest = system ? out.slice(1) : out;
    out = system ? [system, ...rest.slice(-(MAX_MESSAGES - 1))] : rest.slice(-(MAX_MESSAGES - 1));
  }

  // 2) PRUNE tool result cũ TRƯỚC, một lô duy nhất: mất ít thông tin nhất
  //    (khung hội thoại assistant↔tool vẫn nguyên, model vẫn biết đã gọi gì),
  //    chỉ bỏ nội dung ngoài cửa sổ KEEP_RECENT_TOOL_RESULTS.
  if (historyTokens(out) > target) {
    const oldIdx: number[] = [];
    for (let i = 0; i < out.length; i++) if (out[i].role === "tool") oldIdx.push(i);
    const pruneBefore = oldIdx.length - KEEP_RECENT_TOOL_RESULTS;
    if (pruneBefore > 0) {
      const pruneSet = new Set(oldIdx.slice(0, pruneBefore));
      out = out.map((m, i) =>
        pruneSet.has(i) && (m.content?.length ?? 0) > 200 ? { ...m, content: PRUNED_TOOL_RESULT } : m,
      );
    }
  }

  // 3) Vẫn vượt target → BỎ block nguyên khối từ đầu, dừng ở `target`
  //    (hysteresis) chứ không dừng ngay ngưỡng: số lần trim giảm ~3 lần, mỗi
  //    lần vẫn phá KV-cache nhưng tổng thời gian re-prefill thấp hơn hẳn so với
  //    phá cache mỗi bước. Điểm cắt PHẢI thoả cả hai điều kiện để không mồ côi:
  //      (a) message ngay trước điểm cắt không phải assistant có tool_calls;
  //      (b) message tại điểm cắt không phải role "tool" (cha nó đã bị bỏ).
  //    System prompt + nhiệm vụ gốc (message user đầu) luôn được bảo vệ, nên
  //    run MỘT task dài vẫn còn mục tiêu sau trim — logic "nguyên turn" cũ
  //    (cắt từ user này tới user kế tiếp) không bỏ được gì trong case đó.
  const keepsSystem = out[0]?.role === "system";
  const keepsTask = out[keepsSystem ? 1 : 0]?.role === "user";
  const head = (keepsSystem ? 1 : 0) + (keepsTask ? 1 : 0);
  const perMessage: number[] = out.map(messageTokens);
  let total = 0;
  for (let i = 0; i < perMessage.length; i++) total += perMessage[i];
  if (total > target) {
    let cut = head;
    let dropped = 0;
    for (let i = head; i < out.length; i++) {
      if (total - dropped <= target) break;
      dropped += perMessage[i];
      const prev = out[i];
      const next = out[i + 1];
      const safeCut =
        i + 1 <= out.length - 2 &&
        !(prev.role === "assistant" && prev.tool_calls?.length) &&
        next?.role !== "tool";
      if (safeCut) cut = i + 1;
    }
    if (cut > head) out = [...out.slice(0, head), ...out.slice(cut)];
  }

  return out;
}

/**
 * Strict heuristic: does the assistant's plain-text message claim the task is
 * finished? Deliberately narrow — bare words like "done" or "finished" appear
 * in almost any sentence ("I'm not done yet", "package.json is finished with"),
 * which previously triggered spurious build checks. Requires an explicit
 * completion phrase instead.
 */
export function claimsCompletion(text: string): boolean {
  const english = /\b(?:task\s+(?:is\s+)?(?:now\s+)?(?:complete[d]?|done|finished)|all\s+(?:done|finished)|work\s+is\s+(?:now\s+)?(?:complete[d]?|done|finished)|tests?\s+(?:all\s+)?pass(?:ed|ing)?\s*[-—]\s*(?:task|everything)\s+complete[d]?)\b/i.test(
    text,
  );
  // Vietnamese completion claims — same narrow spirit: explicit phrases, not
  // bare words ("xong" alone appears in "chưa xong" and must NOT match).
  const vietnamese =
    /(?:nhiệm\s?vụ|công\s?việc|task|việc)\s+(?:đã\s+)?(?:hoàn\s?thành|xong\s?hoàn\s?toàn|đã\s+xong)|(?:hoàn\s?thành|xong)\s+(?:tất\s+cả|toàn\s+bộ)|đã\s+(?:sửa|xử\s+lý|fix)\s+xong\b/i.test(
      text,
    );
  return english || vietnamese;
}

/**
 * Summarize a long output to keep context lean.
 * For very long tool outputs, keep beginning + error lines + end.
 */export function summariseOutput(output: string, maxChars = 4000): string {
  if (output.length <= maxChars) return output;

  const lines = output.split("\n");
  if (lines.length <= 30) return output.slice(0, maxChars) + "\n... [truncated]";

  const keepStart = Math.min(10, Math.floor(lines.length * 0.1));
  const keepEnd = Math.min(10, Math.floor(lines.length * 0.1));

  const snippet =
    lines.slice(0, keepStart).join("\n") +
    `\n... [${lines.length - keepStart - keepEnd} lines omitted] ...\n` +
    lines.slice(-keepEnd).join("\n");

  return snippet.slice(0, maxChars) + "\n... [truncated]";
}

/** @mention trong task: `@path` hoặc `@"path có space"` — không match email. */
const MENTION_RE = /(?:^|[\s(])@(?:"([^"]+)"|([^\s()'"`,:]+))/g;
const MAX_MENTION_CHARS = 60_000;

/**
 * Expand `@file` mentions trong task thành nội dung file (giống Claude Code):
 * `fix @src/a.ts` → task + block nội dung file. Path được đọc relative workdir;
 * mention không tồn tại giữ nguyên text (LLM tự nhận ra path sai).
 */
export function expandMentions(task: string, workdir: string): string {
  if (!task.includes("@")) return task;
  const mentions: Array<{ token: string; path: string }> = [];
  for (const m of task.matchAll(MENTION_RE)) {
    const path = (m[1] ?? m[2] ?? "").trim();
    if (path) mentions.push({ token: m[0].trimStart(), path });
  }
  if (mentions.length === 0) return task;
  let out = task;
  const blocks: string[] = [];
  for (const { token, path } of mentions) {
    // Chỉ remove token đầu tiên khớp (đề phòng path trùng lặp).
    const idx = out.indexOf(token);
    if (idx >= 0) out = (out.slice(0, idx) + " " + out.slice(idx + token.length)).replace(/ {2,}/g, " ");
    const abs = resolve(workdir, path);
    const root = resolve(workdir);
    const lexical = relative(root, abs);
    let contained = !lexical.startsWith("..") && !isAbsolute(lexical);
    try {
      const realRoot = realpathSync(root);
      const realAbs = realpathSync(abs);
      const realRel = relative(realRoot, realAbs);
      contained = contained && !realRel.startsWith("..") && !isAbsolute(realRel);
    } catch {
      // Missing paths are retained as a diagnostic; existing paths are checked above.
    }
    if (!contained) {
      blocks.push(`@${path}: path escapes working directory — skipped.`);
      continue;
    }
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        // Directory mention → list file bên trong (depth 1).
        const entries = readdirSync(abs).slice(0, 100);
        blocks.push(`@${path}/ (directory):\n${entries.join("\n")}`);
        continue;
      }
      if (st.size > MAX_MENTION_CHARS) {
        blocks.push(`@${path}: too large (${(st.size / 1024).toFixed(0)}KB) — use read_file for it.`);
        continue;
      }
      blocks.push(`@${path}:\n${readFileSync(abs, "utf8").slice(0, MAX_MENTION_CHARS)}`);
    } catch (err) {
      blocks.push(`@${path}: not found (${(err as Error).message.split("\n")[0]})`);
    }
  }
  return `${out.trim()}\n\n${blocks.join("\n\n")}`;
}
