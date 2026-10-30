import type { ChatMessage } from "./llm.js";

const MAX_MESSAGES = 120; // keep history under control for long runs
/** Total history char budget (~25k tokens) before oldest turns are dropped. */
const MAX_HISTORY_CHARS = 100_000;
/** Tool results older than this many recent tool messages get pruned. */
const KEEP_RECENT_TOOL_RESULTS = 20;

/**
 * Trim message history to stay within token budget. Layered strategy
 * (context engineering — inspired by compaction patterns, from scratch):
 *   1. Message-count cap: keep system + newest MAX_MESSAGES-1.
 *   2. Char budget: drop the OLDEST WHOLE TURNS (from a user message up to
 *      the next user message) until under MAX_HISTORY_CHARS — dropping whole
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

  const historyChars = (msgs: ChatMessage[]) => msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0);

  // 2) Char budget — drop oldest whole turns, never the system message
  while (out.length > 2 && historyChars(out) > MAX_HISTORY_CHARS) {
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
  return /\b(?:task\s+(?:is\s+)?(?:now\s+)?(?:complete[d]?|done|finished)|all\s+(?:done|finished)|work\s+is\s+(?:now\s+)?(?:complete[d]?|done|finished)|tests?\s+(?:all\s+)?pass(?:ed|ing)?\s*[-—]\s*(?:task|everything)\s+complete[d]?)\b/i.test(
    text,
  );
}

/**
 * Summarize a long output to keep context lean.
 * For very long tool outputs, keep beginning + error lines + end.
 */
export function summariseOutput(output: string, maxChars = 4000): string {
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
