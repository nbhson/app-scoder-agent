/** Session picker resume flow — restores transcript state and resumes the run. */
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Agent } from "../../agent.js";
import type { AgentConfig } from "../../config.js";
import { resolveSessionId, type SessionSummary } from "../../session.js";
import { initialState, type ChatItem, type TuiState } from "../state.js";

export function useSessionResume(deps: {
  cfg: AgentConfig;
  createAgent: () => Agent;
  pushNotice: (text: string, level?: "info" | "warn" | "error") => void;
  update: (fn: (s: TuiState) => TuiState) => void;
  runningRef: { current: boolean };
  setScrollOffset: Dispatch<SetStateAction<number>>;
  setSessionPickerOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const { cfg, createAgent, pushNotice, update, runningRef, setScrollOffset, setSessionPickerOpen } = deps;
  /** Session picker: when a session is selected, resume it. */
  const handleSessionSelect = useCallback(
    async (session: SessionSummary) => {
      setSessionPickerOpen(false);
      if (runningRef.current) {
        pushNotice("agent is running — wait or Esc first", "warn");
        return;
      }
      const s = resolveSessionId(cfg.workdir, session.id);
      if (!s) {
        pushNotice(`session not found: ${session.id}`, "error");
        return;
      }
      // Restore full TUI state from the session (items + step count + model info).
      update(() => ({
        ...initialState(),
        items: s.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m): ChatItem =>
            m.role === "user"
              ? { kind: "user" as const, text: typeof m.content === "string" ? m.content : "" }
              : { kind: "assistant" as const, text: typeof m.content === "string" ? m.content : "", streaming: false },
          ),
        step: s.steps ?? 0,
        maxSteps: s.maxSteps ?? cfg.maxSteps,
        model: s.model || cfg.model,
        provider: s.provider || cfg.provider,
        status: "idle",
        summary: null,
      }));
      runningRef.current = true;
      setScrollOffset(0);
      const agent = createAgent();
      try {
        await agent.resume(s);
        runningRef.current = false;
      } catch (err) {
        runningRef.current = false;
        pushNotice(`resume failed: ${(err as Error).message}`, "error");
      }
    },
    [cfg, createAgent, pushNotice, update],
  );
  return handleSessionSelect;
}
