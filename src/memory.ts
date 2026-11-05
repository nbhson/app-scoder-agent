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
import type { ChatMessage } from "./llm.js";
import type { TodoItem } from "./tools.js";

export interface WorkingMemory {
  /** The original user task (first user message). */
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

export function emptyWorkingMemory(goal = ""): WorkingMemory {
  return {
    goal: goal.slice(0, 400),
    constraints: [],
    decisions: [],
    filesRead: [],
    filesChanged: [],
    failures: [],
    openQuestions: [],
    nextSteps: [],
  };
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
  const lines: string[] = ["[working memory — decisions & state preserved across compaction]"];
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
    const firstUser = messages.find((m) => m.role === "user" && m.content && !m.content.startsWith("[system]"));
    mem.goal = (typeof firstUser?.content === "string" ? firstUser.content : "").slice(0, 400);
  }
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        toolNameById.set(tc.id, tc.name);
        try {
          const args = JSON.parse(tc.arguments) as Record<string, unknown>;
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
