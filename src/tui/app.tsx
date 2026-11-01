/**
 * Full-screen Ink TUI for scoder — "mission control for the build loop".
 *
 * Identity (deliberately distinct from chat-first agent UIs): the build is
 * the mission, so the screen is organized around it —
 *   · Build Rail (top): brand, model/permission badges, build lamp, fuel gauge
 *   · Flight-recorder log: each tool entry is stamped `07 ▸ name(args)`
 *   · `✎` diff cards rendered inline for every file edit
 *   · Assistant messages render as markdown (code fences, headers, lists)
 *   · Input: ↑/↓ history · Tab command completion · live candidates hint
 * Driven entirely by AgentEvents (the same stream the HTTP/SSE server uses).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useBoxMetrics, useInput, useWindowSize, type DOMElement } from "ink";
import type { AgentConfig } from "../config.js";
import { Agent, type AgentEvent } from "../agent.js";
import { setQuiet } from "../ui.js";
import { discoverSkills } from "../skills.js";
import { discoverAgents } from "../agents.js";
import { applyEvent, initialState, markAborted, visibleWindow, type ChatItem, type TuiState } from "./state.js";
import { parseSlashCommand } from "./commands.js";
import { dispatchCommand, type CommandHost } from "./command-registry.js";
import { ChatItemView, Spinner } from "./chat-views.js"; // T2
import { BuildRail, StatusBar } from "./chrome.js"; // T2
import { Input } from "./input.js"; // T2
import { fileIndex } from "./at-complete.js";
import { getTheme, setActiveTheme, theme, THEMES, useNamedTheme } from "./theme.js";
import { reviewFromResponse, reviewAnswerToCall, type ReviewState } from "./review.js"; // T2
import { PermissionModal } from "./permission-modal.js"; // T2


export interface TuiAppProps {
  config: AgentConfig;
  initialTask: string | null;
}

export function TuiApp({ config, initialTask }: TuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  // T-09: theme resolve at mount (.scoder/theme.json > builtin). Proxy-based
  // theme reads re-render via a bump.
  const [, bump] = useState(0);
  const bumpFrame = useCallback(() => bump((n) => n + 1), []);
  useEffect(() => {
    setActiveTheme(getTheme(config.workdir));
    bumpFrame();
  }, [config.workdir, bumpFrame]);
  const [state, setState] = useState<TuiState>(initialState);
  const [input, setInput] = useState(initialTask ?? "");
  /** Rows scrolled up from the bottom; 0 = follow the newest content. */
  const [scrollOffset, setScrollOffset] = useState(0);
  const [permMode, setPermMode] = useState(config.permissionMode);
  // T-03: active permission prompt (modal) — the run blocks until answered.
  const [permPrompt, setPermPrompt] = useState<Extract<AgentEvent, { type: "permission_request" }> | null>(null);
  const permPromptRef = useRef(permPrompt);
  permPromptRef.current = permPrompt;
  const inputRef = useRef(initialTask ?? "");
  const writeInput = useCallback(
    (v: string) => {
      inputRef.current = v;
      setInput(v);
    },
    [],
  );
  const historyRef = useRef<string[]>([]);
  const runningRef = useRef(false);
  const agentRef = useRef<Agent | null>(null);

  // ── Prompt-gate review flow (/review) ──────────────────────────────────────
  // State machine relaying the universal-prompt-gate-mcp text-fallback flow:
  // call → pending_level_selection → user picks level → pending_user_selection
  // → user picks original/rewritten/update/cancel → approved/cancelled.
  // `argsBase` holds the immutable prompt/context/language; `rewrittenPrompt`
  // is echoed back verbatim from the server's pending result (never from the
  // user or LLM) so only exactly what the user saw can be approved.
  const reviewRef = useRef<ReviewState | null>(null);
  const reviewBusyRef = useRef(false);

  // ── Scrollable chat viewport (Ink 8 alt-screen) ──
  // The viewport clips overflow; the inner content wrapper keeps its natural
  // height so it can be measured and offset upward for scrolling.
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const viewportRowsRef = useRef<number | null>(null);
  useEffect(() => {
    viewportRowsRef.current = viewport.clientHeight || null;
  }, [viewport.clientHeight]);
  const maxScroll = Math.max(0, content.height - viewport.clientHeight);
  // scrollOffset counts rows UP from the bottom; 0 = follow the newest item.
  const scrollTop = Math.max(0, maxScroll - scrollOffset);
  const skills = useMemo(() => discoverSkills(config.workdir), [config.workdir]);
  const skillNames = useMemo(() => skills.map((s) => s.name), [skills]);
  // T-02: completion sources (agents + files) computed once per mount.
  const atSources = useMemo(
    () => ({
      skills: skillNames,
      agents: discoverAgents(config.workdir).filter((a) => a.mode !== "subagent" || a.name === "explore").map((a) => a.name),
      files: fileIndex(config.workdir),
    }),
    [config.workdir, skillNames],
  );

  // Mirror of state for the submit path (isFirst, /cost, /model) and the
  // abort handler — kept in sync synchronously by update() below, so it is
  // exact even between renders (event bursts land between them).
  const stateRef = useRef<TuiState>(state);

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

  const pushNotice = useCallback(
    (text: string, level: "info" | "warn" | "error" = "info") =>
      update((s) => ({ ...s, items: [...s.items, { kind: "notice", text, level }] })),
    [update],
  );

  /** T1: CommandHost cho registry dùng chung với REPL. */
  const tuiHost = useCallback((): CommandHost => ({
    agent: () => agentRef.current,
    config,
    isRunning: () => runningRef.current,
    replaceAgent: (next) => {
      agentRef.current?.abort();
      agentRef.current = next;
      if (!next) {
        runningRef.current = false;
        setScrollOffset(0);
        eventQueue.current = [];
        update(() => initialState());
      }
      setPermMode(config.permissionMode);
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
      return { success: true, steps: 0, buildCmd: config.buildCmd, summary: "resumed" };
    },
  }), [config, update, pushNotice, createAgent]);

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

  const submit = useCallback(
    async (text: string) => {
      const task = text.trim();
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
          if (!Object.keys(config.mcpServers ?? {}).some((s) => s === "prompt-gate")) {
            pushNotice("no \"prompt-gate\" MCP server configured — add it to ~/.scoder/config.json", "error");
            return;
          }
          // Context grounded in this session: last user item + current workdir.
          const lastUser = [...stateRef.current.items].reverse().find((i) => i.kind === "user");
          const context = `User is in scoder TUI at ${config.workdir}${lastUser ? `; earlier they asked: "${(lastUser as { text: string }).text.slice(0, 120)}"` : ""}.`;
          void reviewStep("mcp__prompt-gate__review_and_select_prompt", {
            prompt: slash.arg,
            context,
            language: "vietnamese",
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
        return;
      }
      if (runningRef.current) {
        // Steer: user input while the agent runs — deliver at next step
        // boundary (H-08, "steer by default" — pattern from opencode).
        writeInput("");
        historyRef.current = [...historyRef.current, task].slice(-100);
        agentRef.current?.steer(task);
        update((s) => ({ ...s, items: [...s.items, { kind: "user", text: `${task}  (steered)` }] }));
        return;
      }
      writeInput("");
      historyRef.current = [...historyRef.current, task].slice(-100);
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
    [config, pushNotice, writeInput, exit, update, queueEvent, skills, skillNames, permMode, reviewAnswer, reviewStep, tuiHost],
  );

  /** Create (or return) the session agent — permission mode always current. */
  function createAgent(): Agent {
    if (agentRef.current) return agentRef.current;
    const agent = new Agent({ ...config, permissionMode: permMode });
    // Events go through the batching queue (see FLUSH_MS above): applyEvent
    // still receives the latest state because update() keeps stateRef in
    // sync synchronously — tool results can never miss their items.
    agent.onEvent = queueEvent;
    agentRef.current = agent;
    return agent;
  }

  // Esc aborts the running task (like SIGINT in the CLI); when scrolled up,
  // the first Esc returns to the bottom instead.
  const scrollOffsetRef = useRef(0);
  useEffect(() => {
    scrollOffsetRef.current = scrollOffset;
  }, [scrollOffset]);
  // T-03: permission modal keybinds — intercepts y/a/n/q while open.
  useInput((input, key) => {
    const p = permPromptRef.current;
    if (!p) return;
    const answer = key.return ? "yes" : input.toLowerCase() === "y" ? "yes" : input.toLowerCase() === "a" ? "always" : input.toLowerCase() === "n" ? "no" : input.toLowerCase() === "q" ? "quit" : key.escape ? "no" : null;
    if (!answer) return;
    setPermPrompt(null);
    agentRef.current?.resolvePermission(p.id, answer);
  });

  // T-01/T-02: scroll + abort keybinds.
  useInput((_input, key) => {
    if (permPromptRef.current) return; // modal owns the keyboard
    // T-10: ctrl+t toggles the thinking stream visibility.
    if (key.ctrl && _input === "t") {
      update((s) => ({ ...s, thinkingVisible: !s.thinkingVisible }));
      return;
    }
    if (key.pageUp || key.pageDown || key.home || key.end) {
      const page = Math.max(1, Math.floor((viewportRowsRef.current ?? 20) * 0.8));
      if (key.pageUp) setScrollOffset((o) => o + page);
      if (key.pageDown) setScrollOffset((o) => Math.max(0, o - page));
      if (key.home) setScrollOffset(999_999); // top (clamped to maxScroll in render)
      if (key.end) setScrollOffset(0); // bottom = follow
      return;
    }
    if (key.escape) {
      if (scrollOffsetRef.current > 0) {
        setScrollOffset(0);
        return;
      }
      if (runningRef.current) {
        update((s) => ({ ...markAborted(s), items: [...s.items] }));
        agentRef.current?.abort();
      }
    }
  });

  // Ctrl+C quits (press again within 2s to confirm while running).
  const ctrlCArmed = useRef<number | null>(null);
  useInput((_input, key) => {
    if (!key.ctrl || _input !== "c") return;
    if (runningRef.current && ctrlCArmed.current === null) {
      ctrlCArmed.current = Date.now();
      update((s) => ({ ...s, items: [...s.items, { kind: "notice", text: "Press Ctrl+C again to quit", level: "warn" }] }));
      setTimeout(() => (ctrlCArmed.current = null), 2000);
      return;
    }
    agentRef.current?.abort();
    exit();
  });

  // Submit an initial task passed on the command line once, after mount.
  const bootRef = useRef(false);
  useEffect(() => {
    if (initialTask && !bootRef.current && input === initialTask) {
      bootRef.current = true;
      void submit(initialTask);
    }
  }, [initialTask, input, submit]);

  const lastSummary = useMemo(() => {
    if (state.status === "running" || state.status === "idle") return null;
    return state.summary;
  }, [state.status, state.summary]);

  // When the run ends, jump back to the bottom so the final summary is always
  // visible — a user scrolled up would otherwise never see the conclusion.
  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    if (prevStatusRef.current === "running" && state.status !== "running") setScrollOffset(0);
    prevStatusRef.current = state.status;
  }, [state.status]);

  // The viewport renders items around the visible window (T4 virtualization):
  // chỉ render item có thể hiện ra viewport (+margin) — state giữ full, không
  // còn cap cứng 200. maxScroll vẫn tính trên content thật (useBoxMetrics).
  const viewportRows = viewport.clientHeight || 24;
  const total = state.items.length;
  const visible = useMemo(
    () => visibleWindow(state.items, viewportRows),
    [state.items, viewportRows],
  );
  const { rows } = useWindowSize();

  return (
    // flexShrink={0}: pinned chrome must never be squeezed when the chat
    // content overflows — Ink defaults every box to flexShrink:1, which
    // shrank the input bar to zero rows once the log outgrew the terminal.
    <Box flexDirection="column" height={rows || 24} flexShrink={0}>
      <BuildRail state={state} config={config} />
      {/* Scrollable chat pane — clips overflow so the BuildRail above and the
          input + StatusBar below stay pinned no matter how long the history. */}
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        contentOffsetY={scrollTop}
      >
        <Box ref={contentRef} flexDirection="column" paddingX={1} flexShrink={0}>
          {total === 0 ? (
            <Box flexDirection="column" alignItems="center" gap={1} paddingTop={2}>
              <Text>
                <Text color={theme.brand} bold>◆ scoder</Text>
                <Text dimColor> · autonomous coding agent</Text>
              </Text>
              <Text dimColor>type a task — the agent plans, edits, and builds until it passes</Text>
              <Text>
                <Text dimColor>tab </Text>
                <Text dimColor>complete commands · </Text>
                <Text dimColor>/help </Text>
                <Text dimColor>all commands · </Text>
                <Text dimColor>/skills </Text>
                <Text dimColor>skill packs</Text>
              </Text>
            </Box>
          ) : null}
          {visible.map((item, i) => (
            <ChatItemView key={i} item={item} />
          ))}
          {state.status === "running" && state.step > 0 && (
            <Text dimColor>
              <Spinner active /> step {state.step}/{state.maxSteps} — thinking…
            </Text>
          )}
          {lastSummary && (
            <Box marginTop={1}>
              {state.status === "success" ? (
                <Text color="green" bold>
                  ✔ {lastSummary}
                </Text>
              ) : state.status === "aborted" ? (
                <Text color="yellow" bold>
                  ⏹ {lastSummary}
                </Text>
              ) : (
                <Text color="red" bold>
                  ✘ {lastSummary}
                </Text>
              )}
            </Box>
          )}
        </Box>
      </Box>
      {/* T-03: permission modal — blocks the run until answered. */}
      {permPrompt && <PermissionModal prompt={permPrompt} />}
      <Box paddingX={1} flexShrink={0}>
        <Input
          valueRef={inputRef}
          value={input}
          onChange={writeInput}
          onSubmit={(v) => void submit(v)}
          historyRef={historyRef}
          skillNames={skillNames}
          agentRef={agentRef}
          config={config}
          atSources={atSources}
          modalRef={permPromptRef}
        />
      </Box>
      <StatusBar state={state} scroll={scrollOffset > 0 ? `↑ ${Math.min(scrollOffset, maxScroll)}/${maxScroll}` : null} />
    </Box>
  );
}

/** Mount the TUI (called from the `scoder tui` subcommand). */
export async function runTui(config: AgentConfig, initialTask: string | null): Promise<void> {
  setQuiet(true);
  // T-03: permission=ask works in the TUI — prompts route through the
  // in-pane modal (permission_request events), not stdin readline.
  const { render } = await import("ink");
  // Alternate screen buffer (vim/htop style): the app owns the whole screen,
  // the BuildRail stays pinned at the top and the input at the bottom while
  // the chat pane scrolls internally. Terminal content is restored on exit.
  // Fallback: terminals without alt-screen support (TERM=dumb, non-TTY pipes,
  // some CI runners) render inline instead — the layout still works.
  const altScreen = process.stdout.isTTY === true && process.env.TERM !== "dumb";
  const { waitUntilExit } = render(<TuiApp config={config} initialTask={initialTask} />, {
    alternateScreen: altScreen,
  });
  await waitUntilExit();
  // Ink restores the terminal on unmount; exit explicitly so provider
  // keep-alive sockets (undici pool) can't keep the event loop alive.
  process.exit(0);
}

