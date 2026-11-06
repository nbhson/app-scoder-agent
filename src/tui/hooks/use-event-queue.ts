/**
 * Event batching + the synchronous stateRef mirror for the TUI. Extracted
 * verbatim from app.tsx — flush timing (FLUSH_MS) and reducer order unchanged.
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { AgentEvent } from "../../agent.js";
import { applyEvent, type TuiState } from "../state.js";

export function useEventQueue(
  initial: TuiState,
  setState: Dispatch<SetStateAction<TuiState>>,
  setPermPrompt: Dispatch<SetStateAction<Extract<AgentEvent, { type: "permission_request" }> | null>>,
  runningRef: { current: boolean },
) {
  const stateRef = useRef<TuiState>(initial);

  /**
   * Central state updater — the single source of truth is stateRef, updated
   * synchronously so event handlers never race a render cycle.
   */
  const update = useCallback((fn: (s: TuiState) => TuiState) => {
    stateRef.current = fn(stateRef.current);
    setState(stateRef.current);
  }, []);

  /**
   * Event batching: streaming (`llm_delta`) and live tool output (`tool_output`)
   * can emit hundreds of events per second; each one previously triggered a
   * full-tree re-render (the flicker). Buffer incoming events and flush them
   * through the reducer at most every FLUSH_MS (~20 fps, well above what the
   * eye needs for streaming text).
   */
  const FLUSH_MS = 50;
  const eventQueue = useRef<AgentEvent[]>([]);
  const flushTimer = useRef<NodeJS.Timeout | null>(null);
  const flushEvents = useCallback(() => {
    flushTimer.current = null;
    const events = eventQueue.current;
    if (events.length === 0) return;
    eventQueue.current = [];
    update((s) => {
      let next = s;
      for (const ev of events) next = applyEvent(next, ev);
      return { ...next, items: [...next.items] };
    });
  }, [update]);
  // Realtime tick: re-render at least once per second while a run is active so
  // sidebar metrics (elapsed time, ctx pressure, tok/s during/after a stream)
  // update live instead of only on the next event/command boundary.
  useEffect(() => {
    const id = setInterval(() => {
      if (!runningRef.current) return;
      update((s) => ({ ...s }));
    }, 1000);
    return () => clearInterval(id);
  }, [update]);

  const queueEvent = useCallback(
    (ev: AgentEvent) => {
      // T-03: permission modal must appear instantly (not batched) — the run
      // blocks on the answer.
      if (ev.type === "permission_request") {
        setPermPrompt(ev);
        return;
      }
      eventQueue.current.push(ev);
      if (!flushTimer.current) flushTimer.current = setTimeout(flushEvents, FLUSH_MS);
    },
    [flushEvents],
  );
  // Flush on unmount so a trailing burst is never dropped.
  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushEvents();
    },
    [flushEvents],
  );
  return { stateRef, update, queueEvent, eventQueue };
}
