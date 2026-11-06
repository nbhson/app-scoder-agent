/** T1: CommandHost cho registry dùng chung với REPL. */
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Agent } from "../../agent.js";
import type { AgentConfig } from "../../config/config.js";
import type { CommandHost } from "../../commands/registry.js";
import { initialState, type TuiState } from "../state.js";

export function useCommandHost(deps: {
  cfg: AgentConfig;
  setCfg: Dispatch<SetStateAction<AgentConfig>>;
  update: (fn: (s: TuiState) => TuiState) => void;
  agentRef: { current: Agent | null };
  runningRef: { current: boolean };
  eventQueue: { current: import("../../agent.js").AgentEvent[] };
  setScrollOffset: Dispatch<SetStateAction<number>>;
  setPermMode: Dispatch<SetStateAction<AgentConfig["permissionMode"]>>;
}) {
  const { cfg, setCfg, update, agentRef, runningRef, eventQueue, setScrollOffset, setPermMode } = deps;
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
  }), [cfg, update]);
  return tuiHost;
}
