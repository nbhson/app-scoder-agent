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
import type { ChatMessage, ToolSpec } from "../llm/llm.js";
import { parseToolArgsCached } from "../llm/tool-args.js";
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
 * P1-1 (RC-4): tool schema KHÔNG nằm trong messages nhưng chiếm phần lớn
 * prompt thật. Session baseline: 25.799 input token cho một câu "chào", trong
 * đó ~20.300 token là schema (46 tool MCP + prompt-gate + built-ins).
 * Counting only messages made compaction trigger ~20k token quá muộn.
 *
 * P-perf: cache keyed by the serialized schema TEXT instead of array identity.
 * The old WeakMap missed whenever callers passed freshly-built arrays
 * (`capMcpSchemaTokens`'s per-spec `[spec]` arrays, `allToolSpecs()` per task)
 * — with a content key those become hits. Text building itself is cheap
 * (string concat); `encode` is the expensive part that now runs once per
 * distinct schema content.
 */
const SCHEMA_CACHE_MAX = 64;
const schemaTokenCache = new Map<string, number>();

// P-perf: identity memo for the (tools array → serialized text) step. The
// per-step callers (fixedPromptTokens ×4–6/step, prompt metrics) pass the
// SAME array reference all session long — the string cache below still keyed
// on the serialized TEXT, which forced a full JSON.stringify of ~25 schemas
// per call just to build the lookup key. WeakMap by array identity makes the
// repeated calls O(1); the text cache stays for freshly-built arrays
// (`capMcpSchemaTokens`' per-spec `[spec]` arrays, `allToolSpecs()` copies).
const schemaTextMemo = new WeakMap<ToolSpec[] | readonly ToolSpec[], string>();
const schemaTokenIdentityMemo = new WeakMap<ToolSpec[] | readonly ToolSpec[], number>();

function schemaText(tools: readonly ToolSpec[]): string {
  const hit = schemaTextMemo.get(tools);
  if (hit !== undefined) return hit;
  let text = "";
  for (const t of tools) {
    text += t.function.name + "\n" + (t.function.description ?? "") + "\n" + JSON.stringify(t.function.parameters ?? {}) + "\n";
  }
  try {
    schemaTextMemo.set(tools, text);
  } catch {
    /* frozen/non-extensible array — build the string uncached as before */
  }
  return text;
}

export function estimateSchemaTokens(tools: ToolSpec[] | readonly ToolSpec[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  const identity = schemaTokenIdentityMemo.get(tools);
  if (identity !== undefined) return identity;
  const key = schemaText(tools);
  const hit = schemaTokenCache.get(key);
  if (hit !== undefined) return hit;
  let n: number;
  try {
    n = encode(key).length;
  } catch {
    n = Math.ceil(key.length / 4);
  }
  schemaTokenCache.set(key, n);
  if (schemaTokenCache.size > SCHEMA_CACHE_MAX) {
    const oldest = schemaTokenCache.keys().next().value;
    if (oldest !== undefined) schemaTokenCache.delete(oldest);
  }
  try {
    schemaTokenIdentityMemo.set(tools, n);
  } catch {
    /* non-extensible array — text cache still covers repeats */
  }
  return n;
}

/**
 * P-perf (round 2): the old array memo required `len === messages.length`, so
 * ANY append between two per-step calls (chatWithStream → emitContextEvent →
 * shouldCompact all bracket appends) missed and re-`encode`d the WHOLE joined
 * history — 2–3 full encodes per step, quadratic over a run. History is
 * append-only between structural changes (P0-1): appends mutate
 * `runtime.messages` in place (length grows), while trim/compaction REPLACE
 * the array. An INCREMENTAL prefix sum — per-message tokens from the per-
 * message memo, extended from a checkpoint keyed on (array identity + head +
 * last-computed message) — is exact for this codebase's update patterns:
 * appends cost O(new messages), structural changes fall back to a per-message
 * re-sum (memo hits keep it allocation-free — no giant encode at all).
 * Array value = Σ singleMessageTokens(m) + (n − 1) "\n" join boundaries,
 * i.e. the same per-message unit findCutIndex already uses.
 */
interface PrefixMemo {
  first?: ChatMessage;
  boundary?: ChatMessage;
  len: number;
  total: number;
}
const prefixMemo = new WeakMap<ChatMessage[], PrefixMemo>();
const singleMemo = new WeakMap<
  object,
  { content?: string | null; calls?: ChatMessage["tool_calls"]; nCalls: number; value: number }
>();

function textsOf(messages: ChatMessage[]): string[] {
  const texts: string[] = [];
  for (const m of messages) {
    if (m.content) texts.push(m.content);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) texts.push(tc.name + tc.arguments);
    }
  }
  return texts;
}

function joinEncodedLength(texts: string[]): number {
  try {
    return encode(texts.join("\n")).length + texts.length;
  } catch {
    // old fallback formula (char/4, no boundary bonus) — kept identical
    let chars = 0;
    for (const t of texts) chars += t.length;
    return Math.ceil(chars / 4);
  }
}

function singleMessageTokens(m: ChatMessage): number {
  const hit = singleMemo.get(m);
  if (hit && hit.content === m.content && hit.calls === m.tool_calls && hit.nCalls === (m.tool_calls?.length ?? 0)) {
    return hit.value;
  }
  const value = joinEncodedLength(textsOf([m]));
  try {
    singleMemo.set(m, { content: m.content, calls: m.tool_calls, nCalls: m.tool_calls?.length ?? 0, value });
  } catch {
    /* non-extensible message — skip the cache */
  }
  return value;
}

/**
 * Token-accurate count (I-10): gpt-tokenizer (offline, MIT) thay heuristic
 * ~4 chars/token. Fallback char/4 nếu encode lỗi (never throw).
 * `extraTokens` (P1-1): phần chi phí cố định ngoài messages — tool schemas.
 *
 * Incremental prefix sum — see PrefixMemo above. Σ singleMessageTokens(m) +
 * one "\n" boundary token per message transition; single-message arrays
 * (findCutIndex) return exactly singleMessageTokens, so the cut-index budget
 * math and the total stay on the same unit.
 */
export function estimateTokens(messages: ChatMessage[], extraTokens = 0): number {
  const n = messages.length;
  if (n === 0) return extraTokens;
  if (n === 1) return singleMessageTokens(messages[0]) + extraTokens;
  let hit = prefixMemo.get(messages);
  if (!hit) {
    hit = { len: 0, total: 0 };
    try {
      prefixMemo.set(messages, hit);
    } catch {
      /* non-extensible array — fall through, computed fresh each call */
    }
  }
  // Stale checkpoint: array replaced at the head, shrank past the boundary,
  // or the boundary slot was overwritten in place → re-sum from zero. The
  // per-message memo keeps the re-sum allocation-free (no giant encode).
  if (hit.len > 0 && (hit.first !== messages[0] || hit.len > n || messages[hit.len - 1] !== hit.boundary)) {
    hit.len = 0;
    hit.total = 0;
  }
  if (hit.len === 0) {
    hit.first = messages[0];
    hit.boundary = messages[0];
    hit.len = 1;
    hit.total = singleMessageTokens(messages[0]);
  }
  for (let i = hit.len; i < n; i++) {
    hit.total += singleMessageTokens(messages[i]) + 1; // +1 ≈ "\n" join boundary
    hit.len = i + 1;
    hit.boundary = messages[i];
  }
  return hit.total + extraTokens;
}

/** True when the history should be compacted now. */
export function shouldCompact(messages: ChatMessage[], cfg: CompactionConfig, extraTokens = 0): boolean {
  const budget = cfg.contextWindow * cfg.trigger;
  return estimateTokens(messages, extraTokens) >= budget;
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
          const args = parseToolArgsCached(tc);
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

/** Message sent to the summarizer LLM (v2: structured template, not prose). */
export const COMPACTION_INSTRUCTION =
  "Summarize the conversation above for a coding agent that will CONTINUE this task. " +
  "Use a STRUCTURED template with exactly these sections (skip a section only if empty):\n" +
  "GOAL: one line — the original task.\n" +
  "STATE: what is done and what is not (build/test status).\n" +
  "CHANGED: files created/modified and why.\n" +
  "DECISIONS: decisions made and their rationale (keep every decision).\n" +
  "FAILURES: errors hit and what did NOT work (so they are not repeated).\n" +
  "NEXT: the exact next steps, in order.\n" +
  "Be factual and terse — max 400 words. Preserve file paths, commands and error codes verbatim.";

/** Build the post-compaction message list. */
export function applyCompaction(
  messages: ChatMessage[],
  summary: string,
  cfg: CompactionConfig,
): ChatMessage[] {
  const cut = findCutIndex(messages, cfg);
  const system = messages[0]?.role === "system" ? messages[0] : null;
  const tail = messages.slice(cut);
  // I4: giữ lại "khung" tool-call các turn đã compact — skeleton (name + args
  // truncated) của tool_calls bị cắt, để model biết nó đã thử gì mà không
  // phải trả giá token của output đầy đủ.
  const skeletons: ChatMessage[] = [];
  for (const m of messages.slice(system ? 1 : 0, cut)) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      skeletons.push({
        role: "assistant",
        content: null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments.length > 120 ? tc.arguments.slice(0, 120) + "…" : tc.arguments,
        })),
      });
      for (const tc of m.tool_calls) {
        skeletons.push({ role: "tool", tool_call_id: tc.id, content: "[compacted — tool result omitted]" });
      }
    }
  }
  const summaryMsg: ChatMessage = {
    role: "user",
    content: `[system] Session summary (auto-compact). Earlier history was summarized:\n\n${summary}\n\nContinue the task from here.`,
  };
  return [...(system ? [system] : []), summaryMsg, ...skeletons, ...tail];
}
