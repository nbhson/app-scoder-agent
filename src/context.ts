import type { ChatMessage } from "./llm.js";

const MAX_MESSAGES = 120; // keep history under control for long runs

/**
 * Trim message history to stay within token budget.
 * Strategy: keep system prompt + last N messages, compact older user/assistant pairs.
 */
export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_MESSAGES) return messages;

  // Keep system + last MAX_MESSAGES-1
  const system = messages[0].role === "system" ? messages[0] : null;
  const rest = system ? messages.slice(1) : messages;
  const trimmed = rest.slice(-(MAX_MESSAGES - 1));

  if (system) {
    return [system, ...trimmed];
  }
  return trimmed;
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
