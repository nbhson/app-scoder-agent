/**
 * Shared entry point for every task submission (steer vs. new-run, slash
 * commands). Extracted verbatim from app.tsx.
 */
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Agent, AgentEvent } from "../../agent.js";
import type { AgentConfig } from "../../config/config.js";
import type { Skill } from "../../context/skills.js";
import type { CommandHost } from "../../commands/registry.js";
import { dispatchCommand } from "../../commands/registry.js";
import { parseSlashCommand } from "../../commands/definitions.js";
import { applyEvent, type TuiState } from "../state.js";
import { THEMES, useNamedTheme } from "../theme.js";

export function useSubmit(deps: {
  cfg: AgentConfig;
  pushNotice: (text: string, level?: "info" | "warn" | "error") => void;
  writeInput: (v: string) => void;
  exit: () => void;
  update: (fn: (s: TuiState) => TuiState) => void;
  queueEvent: (ev: AgentEvent) => void;
  skills: Skill[];
  skillNames: string[];
  permMode: AgentConfig["permissionMode"];
  tuiHost: () => CommandHost;
  agentRef: { current: Agent | null };
  runningRef: { current: boolean };
  stateRef: { current: TuiState };
  historyRef: { current: string[] };
  setScrollOffset: Dispatch<SetStateAction<number>>;
  createAgent: () => Agent;
  bumpFrame: () => void;
  /** `/log [cat]` (tui-only) — render the harness log into the full-screen viewer. */
  openLogPager: (arg: string) => void;
}) {
  const { cfg, pushNotice, writeInput, exit, update, queueEvent, skills, skillNames, permMode, tuiHost, agentRef, runningRef, stateRef, historyRef, setScrollOffset, createAgent, bumpFrame, openLogPager } = deps;
  // Close any lingering streaming messages when the user sends a new query —
  // prevents green/dim text from the previous response appearing stale.
  // P-perf: immutable rewrite. Mutating `it.streaming = false` in place left
  // the SAME object references in `items`, so memoized row components (and the
  // virtualization window) saw no prop change and could keep painting the old
  // streaming style until the next unrelated re-render.
  const closeStreamingItems = useCallback(() => {
    update((s) => {
      if (!s.items.some((it) => it.kind === "assistant" && it.streaming)) return s;
      return {
        ...s,
        items: s.items.map((it) => (it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it)),
      };
    });
  }, [update]);

  /**
   * Shared entry point for every task submission:
   *   1. Close any still-streaming assistant message from the previous response.
   *   2. Record the query in history.
   *   3. Clear the input field.
   * Then the caller handles steer vs. new-run separately.
   */
  const preSubmit = useCallback(
    (task: string) => {
      closeStreamingItems();
      historyRef.current = [...historyRef.current, task].slice(-100);
      writeInput("");
    },
    [closeStreamingItems, writeInput],
  );

  const submit = useCallback(
    async (text: string) => {
      let task = text.trim();
      if (!task) return;
      // "exit"/"quit" always works — aborts a running agent first.
      if (task === "exit" || task === "quit") {
        agentRef.current?.abort();
        exit();
        return;
      }
      // Slash commands — TUI-specific first (/theme), then the shared
      // registry (T1) for the rest.
      const slash = parseSlashCommand(task);
      if (slash) {
        writeInput("");
        if (slash.cmd === "/theme") {
          // T-09: palette hot-swap.
          if (!slash.arg) {
            pushNotice(`themes: ${Object.keys(THEMES).join(", ")} — /theme <name>; default via .scoderrc "theme" or .scoder/theme.json`);
            return;
          }
          pushNotice(useNamedTheme(slash.arg.trim()), "info");
          bumpFrame();
          return;
        }
        if (slash.cmd === "/log") {
          // P8 (tui-only): harness log in the full-screen viewer — works on
          // narrow terminals where the sidebar tab is not reachable.
          writeInput("");
          openLogPager(slash.arg.trim());
          return;
        }
        // T1: phần còn lại qua registry dùng chung với REPL.
        const { handled, outcome } = await dispatchCommand(task, tuiHost(), pushNotice);
        if (handled && outcome?.task) {
          task = outcome.task;
        } else {
          return;
        }
      }
      if (runningRef.current) {
        // Steer: user input while the agent runs — deliver at next step
        // boundary (H-08, "steer by default" — pattern from opencode).
        preSubmit(task);
        agentRef.current?.steer(task);
        // Steer = user message mới → plan cũ reset (cùng ngữ nghĩa latestPlan).
        update((s) => ({ ...s, plan: null, items: [...s.items, { kind: "user", text: `${task}  (steered)` }] }));
        return;
      }
      preSubmit(task);
      runningRef.current = true;
      setScrollOffset(0);
      // isFirst must be computed BEFORE pushing the user item below.
      const isFirst = stateRef.current.items.every((i) => i.kind !== "user");
      // run_start (cả run() lẫn runTurn() đều phát) dedupe với dòng user mà TUI
      // vừa push ở dòng trên, nên câu hỏi thứ 2+ không hiển thị hai lần.
      // runTurn cũng reset plan — cùng semantics với run_start.
      update((s) => ({ ...s, plan: null, items: [...s.items, { kind: "user", text: task }], status: "running", summary: null }));

      const agent = createAgent();
      try {
        // First submission runs the full closed loop; later ones continue the session.
        const result = isFirst ? await agent.run(task) : await agent.runTurn(task);
        void result;
        runningRef.current = false;
      } catch (err) {
        runningRef.current = false;
        // Surface the failure through the reducer (not just a notice) so the
        // status leaves "running" and the error is visible as the final line.
        update((s) =>
          applyEvent(
            { ...s, items: [...s.items] },
            { type: "finish", success: false, steps: s.step, summary: `Run failed: ${(err as Error).message}` },
          ),
        );
        update((s) => ({ ...s, items: [...s.items, { kind: "notice", text: (err as Error).message, level: "error" }] }));
      }
    },
    [cfg, pushNotice, writeInput, exit, update, queueEvent, skills, skillNames, permMode, tuiHost, preSubmit],
  );
  return { submit };
}
