/** T1: CommandHost cho registry dùng chung với REPL. */
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Agent } from "../../agent.js";
import type { AgentConfig } from "../../config/config.js";
import type { CommandHost } from "../../commands/registry.js";
import { initialState, estimateItemRows, type ChatItem, type TuiState } from "../state.js";

export function useCommandHost(deps: {
  cfg: AgentConfig;
  setCfg: Dispatch<SetStateAction<AgentConfig>>;
  createAgent: () => Agent;
  pushNotice: (text: string, level?: "info" | "warn" | "error") => void;
  update: (fn: (s: TuiState) => TuiState) => void;
  agentRef: { current: Agent | null };
  runningRef: { current: boolean };
  stateRef: { current: TuiState };
  eventQueue: { current: import("../../agent.js").AgentEvent[] };
  viewport: { height: number };
  content: { height: number };
  setScrollOffset: Dispatch<SetStateAction<number>>;
  setPermMode: Dispatch<SetStateAction<AgentConfig["permissionMode"]>>;
}) {
  const { cfg, setCfg, createAgent, pushNotice, update, agentRef, runningRef, stateRef, eventQueue, viewport, content, setScrollOffset, setPermMode } = deps;
  /** T1: CommandHost cho registry dùng chung với REPL. */
  const tuiHost = useCallback((): CommandHost => ({
    agent: () => agentRef.current,
    config: cfg,
    updateConfig: (patch: Partial<AgentConfig>) => setCfg((c) => ({ ...c, ...patch })),
    isRunning: () => runningRef.current,
    replaceAgent: (next) => {
      agentRef.current?.abort();
      agentRef.current?.dispose();
      agentRef.current = next;
      if (!next) {
        runningRef.current = false;
        setScrollOffset(0);
        eventQueue.current = [];
        update(() => initialState());
      }
      setPermMode(cfg.permissionMode);
    },
    resumeAndRun: async (s) => {
      const agent = createAgent();
      // Replace the pane with the restored transcript, then continue.
      update(() => ({
        ...initialState(),
        items: s.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m): ChatItem => (m.role === "user" ? { kind: "user", text: typeof m.content === "string" ? m.content : "" } : { kind: "assistant", text: typeof m.content === "string" ? m.content : "", streaming: false })),
      }));
      runningRef.current = true;
      setScrollOffset(0);
      try {
        await agent.resume(s);
        runningRef.current = false;
      } catch (err) {
        runningRef.current = false;
        pushNotice(`resume failed: ${(err as Error).message}`, "error");
      }
      return { success: true, steps: 0, buildCmd: cfg.buildCmd, summary: "resumed" };
    },
    /** [Phase 7] Transcript items — used by /export and /search. */
    transcriptItems: () => stateRef.current.items,
    /** [Phase 7] Scroll to a transcript item by index (best-effort row estimation). */
    selectTranscriptItem: (index: number) => {
      const items = stateRef.current.items;
      if (index < 0 || index >= items.length) return;
      // target: show item at index at the TOP of the viewport.
      // Ink contentOffsetY shifts content upward by that many rows.
      let above = 0;
      for (let i = 0; i < index; i++) above += estimateItemRows(items[i]);
      const maxScroll = Math.max(0, content.height - viewport.height);
      setScrollOffset(Math.max(0, maxScroll - above));
    },
  }), [cfg, update, pushNotice, createAgent, viewport, content]);
  return tuiHost;
}
