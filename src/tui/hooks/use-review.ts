/** Prompt-gate /review state machine relay (universal-prompt-gate-mcp text fallback). */
import { useCallback, useRef } from "react";
import type { Agent } from "../../agent.js";
import { reviewFromResponse, reviewAnswerToCall, type ReviewState } from "../review.js";

export function useReview(
  agentRef: { current: Agent | null },
  createAgent: () => Agent,
  pushNotice: (text: string, level?: "info" | "warn" | "error") => void,
) {
  const reviewRef = useRef<ReviewState | null>(null);
  const reviewBusyRef = useRef(false);

  /** One round of the /review state machine: call the gate, render the result. */
  const reviewStep = useCallback(
    async (tool: string, args: Record<string, unknown>) => {
      const agent = agentRef.current ?? createAgent();
      reviewBusyRef.current = true;
      try {
        const r = await agent.callMcpTool(tool, args);
        const out = reviewFromResponse(reviewRef.current, tool, args, r);
        reviewRef.current = out.state;
        if (out.notice) pushNotice(out.notice.text, out.notice.level);
      } catch (err) {
        reviewRef.current = null;
        pushNotice(`prompt gate failed: ${(err as Error).message}`, "error");
      } finally {
        reviewBusyRef.current = false;
      }
    },
    [createAgent, pushNotice],
  );

  /** Handle a user reply while /review is waiting (numbers 1-4 / feedback text). */
  const reviewAnswer = useCallback(
    (text: string) => {
      const rv = reviewRef.current;
      if (!rv || reviewBusyRef.current) return false;
      const out = reviewAnswerToCall(rv, text);
      if (out.notice) pushNotice(out.notice.text, out.notice.level);
      if (out.nextCall) void reviewStep(out.nextCall.tool, out.nextCall.args);
      return true;
    },
    [reviewStep, pushNotice],
  );
  return { reviewRef, reviewStep, reviewAnswer };
}
