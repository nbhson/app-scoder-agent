import type { ChatMessage } from "./llm.js";

const MAX_MESSAGES = 120; // keep history under control for long runs
const MAX_TOTAL_CHARS = 80_000; // rough budget per "context window" safety

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
