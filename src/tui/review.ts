/**
 * T2: /review prompt-gate state machine — tách khỏi app.tsx thành module
 * thuần (test độc lập). Relaying universal-prompt-gate-mcp text-fallback flow:
 * call → pending_level_selection → user picks level → pending_user_selection
 * → user picks original/rewritten/update/cancel → approved/cancelled.
 */
export interface ReviewState {
  stage: "level" | "selection";
  tool: string;
  argsBase: Record<string, unknown>;
  /** Echoed back verbatim from the server's pending result (never from the
   *  user or LLM) so only exactly what the user saw can be approved. */
  rewrittenPrompt?: string;
}

export interface ReviewStepResult {
  ok: boolean;
  /** Notice text hiển thị cho user; null khi caller tự render. */
  notice: { text: string; level: "info" | "warn" | "error" } | null;
  /** MCP tool call kế tiếp (nếu có) — caller thực thi rồi feedbackStep(). */
  nextCall: { tool: string; args: Record<string, unknown> } | null;
  /** args cho nextCall — internal state đã update. */
  state: ReviewState | null;
}

/** Process one MCP gate response — returns notice + optional next call. */
export function reviewFromResponse(
  prev: ReviewState | null,
  tool: string,
  args: Record<string, unknown>,
  r: { ok: boolean; output: string; structured?: Record<string, unknown> },
): ReviewStepResult {
  const err = (text: string, level: "warn" | "error" = "error"): ReviewStepResult =>
    ({ ok: false, notice: { text, level }, nextCall: null, state: null });
  if (!r.ok) return err(`prompt gate error: ${r.output.slice(0, 500)}`);
  const sc = (r.structured ?? {}) as Record<string, unknown>;
  const status = typeof sc.status === "string" ? sc.status : null;
  if (status === "pending_level_selection") {
    return {
      ok: true,
      notice: {
        text:
          "Which rewrite level?\n  [1] light — minimal, close to original\n  [2] balanced — structure + context + criteria\n  [3] detailed — full spec with acceptance criteria\nReply 1, 2 or 3.",
        level: "info",
      },
      nextCall: null,
      state: { stage: "level", tool, argsBase: args },
    };
  }
  if (status === "pending_user_selection") {
    const rewritten = typeof sc.rewritten_prompt === "string" ? sc.rewritten_prompt : "";
    return {
      ok: true,
      notice: {
        text: `--- ORIGINAL ---\n${String(sc.original_prompt ?? "(missing)")}\n\n--- REWRITTEN ---\n${rewritten}\n\nWhich should be used?\n  [1] original\n  [2] rewritten\n  [3] update — describe changes, rewrite again\n  [4] cancel\nReply 1-4 (or 3 + your changes).`,
        level: "info",
      },
      nextCall: null,
      state: { stage: "selection", tool, argsBase: args, rewrittenPrompt: rewritten },
    };
  }
  if (status === "approved") return { ok: true, notice: { text: `✔ prompt approved:\n${String(sc.selected_prompt ?? "")}`, level: "info" }, nextCall: null, state: null };
  if (status === "cancelled") return { ok: true, notice: { text: "⏹ prompt gate cancelled — nothing approved.", level: "info" }, nextCall: null, state: null };
  return err(`prompt gate: unexpected status ${status ?? "(none)"}\n${r.output.slice(0, 500)}`, "warn");
}

/** Handle a user reply while /review is waiting (numbers 1-4 / feedback text). */
export function reviewAnswerToCall(
  rv: ReviewState,
  text: string,
): { notice: { text: string; level: "info" | "warn" | "error" } | null; nextCall: { tool: string; args: Record<string, unknown> } | null } {
  const m = /^([1-4])(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (rv.stage === "level") {
    if (!m) return { notice: { text: "reply 1, 2 or 3 to pick the rewrite level", level: "warn" }, nextCall: null };
    const levels = ["light", "balanced", "detailed"];
    return { notice: null, nextCall: { tool: rv.tool, args: { ...rv.argsBase, rewrite_level: levels[Number(m[1]) - 1] } } };
  }
  // stage === "selection"
  if (!m) return { notice: { text: "reply 1-4 (or 3 + your requested changes)", level: "warn" }, nextCall: null };
  const n = m[1];
  if (n === "3") {
    const feedback = m[2]?.trim();
    if (!feedback) return { notice: { text: "update needs your requested changes: 3 <what to change>", level: "warn" }, nextCall: null };
    return { notice: null, nextCall: { tool: rv.tool, args: { ...rv.argsBase, selection: "update", feedback, rewritten_prompt: rv.rewrittenPrompt } } };
  }
  const selection = n === "1" ? "original" : n === "2" ? "rewritten" : "cancel";
  return {
    notice: null,
    nextCall: {
      tool: rv.tool,
      args: { ...rv.argsBase, selection, ...(selection === "rewritten" ? { rewritten_prompt: rv.rewrittenPrompt } : {}) },
    },
  };
}
