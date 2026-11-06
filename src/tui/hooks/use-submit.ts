/**
 * Shared entry point for every task submission (steer vs. new-run, slash
 * commands, /review relay). Extracted verbatim from app.tsx.
 */
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Agent, AgentEvent } from "../../agent.js";
import type { AgentConfig } from "../../config/config.js";
import type { Skill } from "../../skills.js";
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
  reviewRef: { current: unknown };
  reviewAnswer: (text: string) => boolean;
  reviewStep: (tool: string, args: Record<string, unknown>) => Promise<void>;
  tuiHost: () => CommandHost;
  agentRef: { current: Agent | null };
  runningRef: { current: boolean };
  stateRef: { current: TuiState };
  historyRef: { current: string[] };
  setScrollOffset: Dispatch<SetStateAction<number>>;
  createAgent: () => Agent;
  bumpFrame: () => void;
}) {
  const { cfg, pushNotice, writeInput, exit, update, queueEvent, skills, skillNames, permMode, reviewRef, reviewAnswer, reviewStep, tuiHost, agentRef, runningRef, stateRef, historyRef, setScrollOffset, createAgent, bumpFrame } = deps;
  // Close any lingering streaming messages when the user sends a new query —
  // prevents green/dim text from the previous response appearing stale.
  const closeStreamingItems = useCallback(() => {
    update((s) => {
      let changed = false;
      for (const it of s.items) {
        if (it.kind === "assistant" && it.streaming) {
          it.streaming = false;
          changed = true;
        }
      }
      return changed ? { ...s, items: [...s.items] } : s;
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
      // Prompt-gate review in progress — numeric replies drive the flow.
      if (reviewRef.current) {
        writeInput("");
        historyRef.current = [...historyRef.current, task].slice(-100);
        reviewAnswer(task);
        return;
      }
      // "exit"/"quit" always works — aborts a running agent first.
      if (task === "exit" || task === "quit") {
        agentRef.current?.abort();
        exit();
        return;
      }
      // Slash commands — TUI-specific first (/review /diff /theme /undo),
      // then the shared registry (T1) for the rest.
      const slash = parseSlashCommand(task);
      if (slash) {
        writeInput("");
        if (slash.cmd === "/review") {
          if (!slash.arg) {
            pushNotice("usage: /review <prompt> — rewrites it, you pick original/rewritten/update/cancel", "warn");
            return;
          }
          // v2: no hardcoded server/language — any MCP server exposing a
          // review_and_select_prompt tool wins; language is auto-detected by
          // the gate from the prompt itself.
          const servers = Object.keys(cfg.mcpServers ?? {});
          const gateServer = servers.find((s) => s === "prompt-gate") ?? servers.find((s) => /gate/i.test(s));
          if (!gateServer) {
            pushNotice("no MCP prompt-gate server configured — add one exposing review_and_select_prompt to ~/.scoder/config.json", "error");
            return;
          }
          // Context grounded in this session: last user item + current workdir.
          const lastUser = [...stateRef.current.items].reverse().find((i) => i.kind === "user");
          const context = `User is in scoder TUI at ${cfg.workdir}${lastUser ? `; earlier they asked: "${(lastUser as { text: string }).text.slice(0, 120)}"` : ""}.`;
          void reviewStep(`mcp__${gateServer}__review_and_select_prompt`, {
            prompt: slash.arg,
            context,
          });
          return;
        }
        if (slash.cmd === "/diff") {
          // T-06: /diff turn | session | branch (default: turn). TUI-specific —
          // turn scope reads the reducer's diff items.
          const scope = slash.arg.trim() || "turn";
          const diffs = stateRef.current.items.filter((i) => i.kind === "diff");
          if (scope === "turn") {
            // Diffs since the last user message (current turn).
            let count = 0;
            const turnDiffs: string[] = [];
            for (let i = stateRef.current.items.length - 1; i >= 0; i--) {
              const it = stateRef.current.items[i];
              if (it.kind === "user" && count > 0) break;
              if (it.kind === "diff") {
                count++;
                turnDiffs.unshift(`✎ ${it.path} (+${it.added}/-${it.removed})\n${it.text}`);
              }
            }
            pushNotice(turnDiffs.length ? turnDiffs.join("\n\n") : "no file edits in this turn yet");
          } else if (scope === "session") {
            const total = diffs.reduce((a, d) => ({ add: a.add + d.added, rem: a.rem + d.removed }), { add: 0, rem: 0 });
            pushNotice(
              diffs.length === 0
                ? "no file edits this session"
                : diffs.map((d) => `✎ ${d.path} (+${d.added}/-${d.removed})`).join("\n") + `\n${diffs.length} files · +${total.add}/-${total.rem}`,
            );
          } else if (scope === "branch") {
            const agent = agentRef.current;
            const snaps = agent?.snapshots.list() ?? [];
            if (!agent || snaps.length === 0) {
              pushNotice("no snapshot checkpoints — /diff branch needs at least one captured edit batch");
            } else {
              const d = agent.snapshots.diff(snaps[0].tree, null);
              pushNotice(d ? d : "worktree matches the first checkpoint (no net change)");
            }
          } else {
            pushNotice("usage: /diff [turn|session|branch]", "warn");
          }
          return;
        }
        if (slash.cmd === "/theme") {
          // T-09: palette hot-swap.
          if (!slash.arg) {
            pushNotice(`themes: ${Object.keys(THEMES).join(", ")} — /theme <name>; project default qua .scoder/theme.json`);
            return;
          }
          pushNotice(useNamedTheme(slash.arg.trim()), "info");
          bumpFrame();
          return;
        }
        if (slash.cmd === "/undo") {
          // T-07: /undo [edit|turn|files]
          //   (bare)|files — revert files to the previous checkpoint.
          //   edit — files + trim conversation back one turn, then the user
          //          can edit and re-send (fork/edit-resend, opencode UX).
          const agent = agentRef.current;
          const mode = slash.arg.trim() || "files";
          const cps = agent?.snapshots.list() ?? [];
          if (!agent || cps.length < 2) {
            pushNotice("undo: no snapshot checkpoint to revert to", "warn");
            return;
          }
          if (mode !== "files" && mode !== "edit") {
            pushNotice("usage: /undo [files|edit]", "warn");
            return;
          }
          // Revert to the second-newest checkpoint (newest = current state).
          const target = cps[cps.length - 2];
          const ok = agent.snapshots.restore(target.tree);
          if (!ok) {
            pushNotice("undo: restore failed", "warn");
            return;
          }
          if (mode === "edit") {
            // Fork: trim the transcript UI back to the last user message and
            // put it in the input for editing + re-send.
            const items = stateRef.current.items;
            let lastUserIdx = -1;
            for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "user") { lastUserIdx = i; break; }
            const resend = lastUserIdx >= 0 && items[lastUserIdx].kind === "user" ? (items[lastUserIdx] as { text: string }).text : "";
            update((s) => ({ ...s, items: lastUserIdx >= 0 ? items.slice(0, lastUserIdx) : s.items, status: "idle", summary: null }));
            if (resend) writeInput(resend);
            agent.trimLastTurn();
            pushNotice(`undo edit: files → ${target.id}; last task back in the input — edit + re-send`, "info");
          } else {
            pushNotice(`undo: reverted to ${target.id} (${target.label})`);
          }
          return;
        }
        // T1: phần còn lại qua registry dùng chung với REPL.
        const { handled, outcome } = await dispatchCommand(task, tuiHost(), pushNotice);
        if (handled && outcome?.quit) {
          agentRef.current?.abort();
          exit();
        }
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
        update((s) => ({ ...s, items: [...s.items, { kind: "user", text: `${task}  (steered)` }] }));
        return;
      }
      preSubmit(task);
      runningRef.current = true;
      setScrollOffset(0);
      // isFirst must be computed BEFORE pushing the user item below.
      const isFirst = stateRef.current.items.every((i) => i.kind !== "user");
      // runTurn() doesn't emit run_start, so the TUI shows the user's message
      // itself; applyEvent's run_start dedupe keeps turn 1 from doubling.
      update((s) => ({ ...s, items: [...s.items, { kind: "user", text: task }], status: "running", summary: null }));

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
    [cfg, pushNotice, writeInput, exit, update, queueEvent, skills, skillNames, permMode, reviewAnswer, reviewStep, tuiHost, preSubmit],
  );
  return { submit };
}
