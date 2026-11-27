/**
 * v2 (3.4): WorkingMemory — structured ledger of the run that survives
 * compaction and resume.
 *
 * The ledger is maintained incrementally during the run (tool results, plan
 * updates, build failures) and can be fully REBUILT from the message
 * history on resume (memoryFromMessages) — so old sessions restore their
 * context without any extra persistence machinery.
 *
 * Budget: formatWorkingMemory() is capped (~≤1.5k tokens); callers should
 * inject it on compaction and every N steps, never the raw accumulators.
 */
import type { ChatMessage } from "../llm/llm.js";
import { parseToolArgsCached } from "../llm/tool-args.js";
import type { TodoItem } from "../tools/types.js";

export interface WorkingMemory {
  /** Yêu cầu hiện tại của user (lượt gần nhất — không phải tin nhắn đầu phiên). */
  goal: string;
  /** Standing constraints the user/repo imposed (from AGENTS.md / instructions). */
  constraints: string[];
  /** Decisions the agent made (heuristic: assistant lines led by "Decision:" etc). */
  decisions: string[];
  /** Relative paths read via read_file. */
  filesRead: string[];
  /** Relative paths written/edited (write_file, edit_file, apply_patch). */
  filesChanged: string[];
  /** Recent failures (build failures, tool errors, aborted approaches). */
  failures: string[];
  /** Questions the agent is blocked on / waiting for the user. */
  openQuestions: string[];
  /** Pending steps — derived from the current plan (write_todos). */
  nextSteps: string[];
}

const CAP = {
  constraints: 10,
  decisions: 12,
  filesRead: 25,
  filesChanged: 30,
  failures: 10,
  openQuestions: 10,
  nextSteps: 15,
} as const;

/** Trần độ dài goal trong ledger — đủ ngắn để inject mỗi 6 bước, đủ dài để model không lạc. */
const GOAL_CAP = 400;

/**
 * Block harness tự chèn vào hội thoại (KHÔNG phải yêu cầu của user): repo map,
 * ledger fold, reminder của guardrail. Nhận diện sai ⇒ `goal` lấy nhầm boilerplate.
 */
const SYNTHETIC_BLOCKS = [
  "[system]",
  "[system-reminder]",
  "<system-reminder>",
  "[Context —",
  "[working memory",
];

/** True khi một message role=user là block do harness sinh ra. */
export function isSyntheticUserBlock(content: unknown): boolean {
  const c = String(content ?? "").trimStart().replace(/\s+/g, " ");
  if (!c) return true;
  if (SYNTHETIC_BLOCKS.some((p) => c.startsWith(p))) return true;
  if (c.includes("<system-reminder>")) return true;
  return /^Continue working on (?:the task|the original task)\./.test(c);
}

/**
 * Chuẩn hoá task thành goal cho ledger. REPL nối dần `currentTask` qua nhiều lượt
 * (agent.ts: `${this.currentTask}\n${task}`) ⇒ khi cắt, phải giữ ĐUÔI — yêu cầu MỚI
 * NHẤT — chứ không giữ đầu (log thật: goal "chào" sống sót cả phiên, model chào lại
 * thay vì trả lời — session 20261127-104714-602d).
 */
function goalFromTask(task: unknown): string {
  // Một DÒNG duy nhất: block ledger render `goal: …`, xuống dòng là dòng tiếp theo
  // bị model đọc thành field khác (và làm vỡ các parser của chính ledger).
  const t = String(task ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= GOAL_CAP ? t : `…${t.slice(-(GOAL_CAP - 1))}`;
}

export function emptyWorkingMemory(goal = ""): WorkingMemory {
  return {
    goal: goalFromTask(goal),
    constraints: [],
    decisions: [],
    filesRead: [],
    filesChanged: [],
    failures: [],
    openQuestions: [],
    nextSteps: [],
  };
}

/**
 * Cập nhật goal khi user gửi request MỚI trong cùng một phiên (lượt REPL).
 * Ledger giữ nguyên phần còn lại (files/failures/decisions) — chỉ goal là lỗi thời.
 * Lượt ngắn ("tiến hành", "cho tôi câu trả lời?") không đủ ngữ nghĩa tự thân ⇒
 * giữ thêm request cũ phía sau để model không lạc.
 */
export function setMemoryGoal(mem: WorkingMemory, task: string): void {
  const t = goalFromTask(task);
  if (!t) return;
  if (mem.goal === t) return;
  const base = (mem.goal || "").split(" (follow-up to: ")[0];
  if (t.length <= 48 && base && base !== t) {
    mem.goal = `${t} (follow-up to: ${base})`.slice(0, GOAL_CAP);
    return;
  }
  mem.goal = t;
}

function pushUnique(list: string[], item: string, cap: number): void {
  const v = item.trim().slice(0, 200);
  if (!v) return;
  if (list.includes(v)) return;
  list.push(v);
  if (list.length > cap) list.splice(0, list.length - cap);
}

export function noteFileRead(mem: WorkingMemory, path: string): void {
  pushUnique(mem.filesRead, path, CAP.filesRead);
}

export function noteFileChanged(mem: WorkingMemory, path: string): void {
  pushUnique(mem.filesChanged, path, CAP.filesChanged);
}

export function noteDecision(mem: WorkingMemory, text: string): void {
  pushUnique(mem.decisions, text, CAP.decisions);
}

export function noteFailure(mem: WorkingMemory, text: string): void {
  pushUnique(mem.failures, text, CAP.failures);
}

export function noteOpenQuestion(mem: WorkingMemory, text: string): void {
  pushUnique(mem.openQuestions, text, CAP.openQuestions);
}

export function noteConstraint(mem: WorkingMemory, text: string): void {
  pushUnique(mem.constraints, text, CAP.constraints);
}

/** Decision heuristic: explicit "Decision:" / "Decided:" / "Quyết định" / "Chốt" lines in assistant prose. */
export function scanDecisions(mem: WorkingMemory, text: string): void {
  for (const line of text.split("\n")) {
    const mm = /^\s*(?:[-*]\s*)?(?:decision|decided|quyết định|chốt)\s*[:-]\s*(.+)$/i.exec(line);
    if (mm?.[1]) noteDecision(mem, mm[1].trim());
  }
}

export function notePlan(mem: WorkingMemory, items: TodoItem[]): void {
  mem.nextSteps = items
    .filter((t) => t.status !== "completed")
    .map((t) => `${t.status === "in_progress" ? "▸" : "·"} ${t.content}`)
    .slice(0, CAP.nextSteps);
}

/** True when the memory carries anything worth injecting. */
export function memoryIsMeaningful(mem: WorkingMemory): boolean {
  return (
    mem.filesRead.length > 0 ||
    mem.filesChanged.length > 0 ||
    mem.decisions.length > 0 ||
    mem.failures.length > 0 ||
    mem.nextSteps.length > 0 ||
    mem.constraints.length > 0
  );
}

/** Condensed ledger block for the prompt (~≤1.5k tokens). */
export function formatWorkingMemory(mem: WorkingMemory): string {
  const lines: string[] = [
    "[working memory — decisions & state preserved across compaction]",
    // Không nói rõ điều này, model coi block (role=user) như lời nhắn mới và…
    // trả lời đúng dòng "goal:" cũ (log thật: 20261127-105851-7fb8).
    "Harness context — this block is NOT a new user request; do not reply to it, keep working on the goal below.",
  ];
  if (mem.goal) lines.push(`goal: ${mem.goal}`);
  if (mem.constraints.length > 0) lines.push(`constraints:\n${mem.constraints.map((s) => `  - ${s}`).join("\n")}`);
  if (mem.decisions.length > 0) lines.push(`decisions:\n${mem.decisions.map((s) => `  - ${s}`).join("\n")}`);
  if (mem.filesRead.length > 0) lines.push(`files read (${mem.filesRead.length}): ${mem.filesRead.join(", ")}`);
  if (mem.filesChanged.length > 0) lines.push(`files changed (${mem.filesChanged.length}): ${mem.filesChanged.join(", ")}`);
  if (mem.failures.length > 0) lines.push(`failures to avoid repeating:\n${mem.failures.map((s) => `  - ${s}`).join("\n")}`);
  if (mem.openQuestions.length > 0) lines.push(`open questions:\n${mem.openQuestions.map((s) => `  - ${s}`).join("\n")}`);
  if (mem.nextSteps.length > 0) lines.push(`remaining plan:\n${mem.nextSteps.map((s) => `  ${s}`).join("\n")}`);
  return lines.join("\n");
}

/**
 * Rebuild the ledger from message history — used on resume and to seed a
 * fresh run. Deterministic: reads tool_calls (args.path), tool results, and
 * assistant prose for decision markers.
 */
export function memoryFromMessages(messages: ChatMessage[], goal?: string): WorkingMemory {
  const mem = emptyWorkingMemory(goal ?? "");
  const toolNameById = new Map<string, string>();
  if (!mem.goal) {
    // Request THẬT gần nhất của user — bỏ qua block harness (repo map/ledger/
    // reminder), nếu không goal thành 8k dòng "[Context — repository map…]" và
    // mọi lượt sau model làm theo boilerplate đó.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user" || typeof m.content !== "string") continue;
      if (isSyntheticUserBlock(m.content)) continue;
      mem.goal = goalFromTask(m.content);
      if (mem.goal) break;
    }
  }
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        toolNameById.set(tc.id, tc.name);
        try {
          const args = parseToolArgsCached(tc);
          if (tc.name === "read_file" && typeof args.path === "string") noteFileRead(mem, args.path);
          if ((tc.name === "write_file" || tc.name === "edit_file" || tc.name === "apply_patch") && typeof args.path === "string") {
            noteFileChanged(mem, args.path);
          }
          if (tc.name === "write_todos" && Array.isArray((args as { todos?: TodoItem[] }).todos)) {
            notePlan(mem, (args as { todos: TodoItem[] }).todos);
          }
        } catch {
          // skip malformed args
        }
      }
      // Decision heuristic: explicit "Decision:" / "Decided:" / "Quyết định" lines.
      if (typeof m.content === "string") {
        scanDecisions(mem, m.content);
      }
    }
    if (m.role === "tool" && typeof m.content === "string") {
      const name = m.name ?? toolNameById.get(m.tool_call_id ?? "") ?? "";
      const isError = /^(ERROR|.*\b(failed|failure|fatal)\b)/i.test(m.content.trim()) || /error/i.test(m.content.slice(0, 80));
      if (isError) {
        const first = m.content.split("\n").find((l) => l.trim().length > 0) ?? m.content;
        noteFailure(mem, `${name || "tool"}: ${first.trim().slice(0, 160)}`);
      }
    }
  }
  return mem;
}
