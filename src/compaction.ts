/**
 * LLM compaction — rolling summary of old turns when history approaches the
 * model's context window (H-10).
 *
 * Source: anomalyco/opencode (packages/core/src/session/compaction.ts) —
 * formula adapted to plain TS: estimate tokens, trigger at `trigger` fraction
 * of the context window, summarize everything except the most recent
 * `keep`+`buffer` fractions, inject the summary as a system reminder.
 *
 * Invariant: an assistant tool_calls message is never separated from its tool
 * results — compaction only cuts at whole turn boundaries (user → next user).
 */
import type { ChatMessage } from "./llm.js";
import { encode } from "gpt-tokenizer";

export interface CompactionConfig {
  /** Fraction of contextWindow that triggers compaction (default 0.8). */
  trigger: number;
  /** Fraction of history (by tokens) kept verbatim at the tail (default 0.15). */
  keep: number;
  /** Extra fraction of recent history never summarized (default 0.15). */
  buffer: number;
  /** Model context window in tokens (default 128k). */
  contextWindow: number;
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  trigger: 0.8,
  keep: 0.15,
  buffer: 0.15,
  contextWindow: 128_000,
};

/**
 * Token-accurate count (I-10): gpt-tokenizer (offline, MIT) thay heuristic
 * ~4 chars/token. Fallback char/4 nếu encode lỗi (never throw).
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  const texts: string[] = [];
  for (const m of messages) {
    if (m.content) texts.push(m.content);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) texts.push(tc.name + tc.arguments);
    }
  }
  try {
    return encode(texts.join("\n")).length + texts.length;
  } catch {
    for (const t of texts) chars += t.length;
    return Math.ceil(chars / 4);
  }
}

/** True when the history should be compacted now. */
export function shouldCompact(messages: ChatMessage[], cfg: CompactionConfig): boolean {
  const budget = cfg.contextWindow * cfg.trigger;
  return estimateTokens(messages) >= budget;
}

/** Index where the verbatim tail begins (never inside a tool_calls/tool pair). */
export function findCutIndex(messages: ChatMessage[], cfg: CompactionConfig): number {
  const total = estimateTokens(messages);
  if (total <= 0) return messages.length;
  const tailBudget = (cfg.keep + cfg.buffer) * total;
  let acc = 0;
  // Walk from the tail, stopping at a user-message boundary.
  let i = messages.length - 1;
  while (i > 0) {
    acc += estimateTokens([messages[i]]);
    if (acc >= tailBudget && messages[i].role === "user") {
      return i;
    }
    i--;
  }
  return messages.length; // nothing to compact
}

/** Extract a compact text digest from messages (task + files touched + asks). */
export function extractSummaryInput(task: string, messages: ChatMessage[]): string {
  const lines: string[] = [`Original task: ${task}`];
  const files = new Set<string>();
  for (const m of messages) {
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        try {
          const args = JSON.parse(tc.arguments) as Record<string, unknown>;
          const p = args.path ?? args.file_path ?? args.file;
          if (typeof p === "string") files.add(p);
          if (tc.name === "run_command" && typeof args.command === "string") {
            lines.push(`- ran: ${args.command.slice(0, 120)}`);
          }
        } catch { /* skip malformed args */ }
      }
    }
    if (m.role === "user" && m.content && !m.content.startsWith("[system]")) {
      lines.push(`- user said: ${m.content.slice(0, 200)}`);
    }
  }
  if (files.size > 0) lines.push(`Files modified: ${[...files].join(", ")}`);
  return lines.join("\n");
}

/** Message sent to the summarizer LLM. */
export const COMPACTION_INSTRUCTION =
  "Summarize the conversation above for a coding agent that will CONTINUE this task. " +
  "Include: (1) the original task, (2) what has been done so far and why, " +
  "(3) files created/modified, (4) current build/test state, (5) exact next steps. " +
  "Be factual and terse. Max 300 words.";

/** Build the post-compaction message list. */
export function applyCompaction(
  messages: ChatMessage[],
  summary: string,
  cfg: CompactionConfig,
): ChatMessage[] {
  const cut = findCutIndex(messages, cfg);
  const system = messages[0]?.role === "system" ? messages[0] : null;
  const tail = messages.slice(cut);
  const summaryMsg: ChatMessage = {
    role: "user",
    content: `[system] Session summary (auto-compact). Earlier history was summarized:\n\n${summary}\n\nContinue the task from here.`,
  };
  return [...(system ? [system] : []), summaryMsg, ...tail];
}
