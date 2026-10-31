import type { ChatMessage } from "./llm.js";
import { encode } from "gpt-tokenizer";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const MAX_MESSAGES = 120; // keep history under control for long runs
/**
 * Total history token budget (I-10: token-accurate via gpt-tokenizer, thay
 * char heuristic 100k chars ≈ 25k tokens). Conservative: system prompt +
 * tool defs + reply buffer chiếm phần còn lại của contextWindow.
 */
const MAX_HISTORY_TOKENS = 90_000;
/** Tool results older than this many recent tool messages get pruned. */
const KEEP_RECENT_TOOL_RESULTS = 20;

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

/**
 * Trim message history to stay within token budget. Layered strategy
 * (context engineering — inspired by compaction patterns, from scratch):
 *   1. Message-count cap: keep system + newest MAX_MESSAGES-1.
 *   2. Token budget: drop the OLDEST WHOLE TURNS (from a user message up to
 *      the next user message) until under MAX_HISTORY_TOKENS — dropping whole
 *      turns never orphans an assistant tool_calls / tool result pair.
 *   3. Old tool results (outside the recent window) are pruned in place to a
 *      short placeholder — their content dominated the budget anyway.
 */
export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  let out = messages;

  // 1) Message-count cap
  if (out.length > MAX_MESSAGES) {
    const system = out[0].role === "system" ? out[0] : null;
    const rest = system ? out.slice(1) : out;
    out = system ? [system, ...rest.slice(-(MAX_MESSAGES - 1))] : rest.slice(-(MAX_MESSAGES - 1));
  }

  // 2) Token budget — drop oldest whole turns, never the system message
  while (out.length > 2 && historyTokens(out) > MAX_HISTORY_TOKENS) {
    const firstIdx = out[0].role === "system" ? 1 : 0;
    if (out[firstIdx]?.role !== "user") break; // no clean turn boundary — stop
    let next = firstIdx + 1;
    while (next < out.length && out[next].role !== "user") next++;
    out = [...out.slice(0, firstIdx), ...out.slice(next)];
  }

  // 3) Prune old tool-result contents (safe: contents only, never removals —
  // removing a tool message would orphan its assistant tool_calls entry).
  const toolIdx: number[] = [];
  for (let i = 0; i < out.length; i++) if (out[i].role === "tool") toolIdx.push(i);
  const pruneBefore = toolIdx.length - KEEP_RECENT_TOOL_RESULTS;
  if (pruneBefore > 0) {
    out = out.map((m, i) =>
      toolIdx.includes(i) && toolIdx.indexOf(i) < pruneBefore && (m.content?.length ?? 0) > 200
        ? { ...m, content: "[pruned — old tool result]" }
        : m,
    );
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
    if (!abs.startsWith(resolve(workdir))) {
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
