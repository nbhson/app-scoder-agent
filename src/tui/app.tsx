/**
 * Full-screen Ink TUI for scoder — "mission control for the build loop".
 *
 * Identity (deliberately distinct from chat-first agent UIs): the build is
 * the mission, so the screen is organized around it —
 *   · Build Rail (top): brand, build-status lamp, step fuel gauge ▰▰▰▱▱▱
 *   · Flight-recorder log: each tool entry is stamped `07 ▸ name(args)`
 *   · `✎` diff cards rendered inline for every file edit
 * Driven entirely by AgentEvents (the same stream the HTTP/SSE server uses).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { AgentConfig } from "../config.js";
import { Agent } from "../agent.js";
import { setQuiet } from "../ui.js";
import { applyEvent, initialState, markAborted, type ChatItem, type TuiState } from "./state.js";
import { formatSlashHelp, parseSlashCommand } from "./commands.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Fuel gauge is scaled to this many cells regardless of maxSteps. */
const GAUGE_CELLS = 10;

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [active]);
  return SPINNER_FRAMES[frame];
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
      return `${k}=${s.length > 60 ? s.slice(0, 60) + "…" : s.replace(/\n/g, " ")}`;
    })
    .join(" ");
}

/** Scaled step fuel gauge: ▰ filled / ▱ remaining, e.g. ▰▰▰▰▱▱▱▱ 4/40. */
function fuelGauge(step: number, maxSteps: number): string | null {
  if (maxSteps <= 0) return null;
  const filled = Math.min(GAUGE_CELLS, Math.round((Math.min(step, maxSteps) / maxSteps) * GAUGE_CELLS));
  return "▰".repeat(filled) + "▱".repeat(GAUGE_CELLS - filled);
}

const OUTPUT_PREVIEW_LINES = 4;

function ToolItemView({ item, spinner }: { item: Extract<ChatItem, { kind: "tool" }>; spinner: string }): React.JSX.Element {
  const running = item.ok === null;
  const icon = running ? <Text color="cyan">{spinner}</Text> : item.ok ? <Text color="green">✔</Text> : <Text color="red">✘</Text>;
  const lines = item.output.length > 0 ? item.output.replace(/\n+$/, "").split("\n") : [];
  const preview = lines.slice(-OUTPUT_PREVIEW_LINES);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <Text dimColor>{String(item.step).padStart(2, "0")}▸</Text> {icon}{" "}
        <Text color="cyan">{item.name}</Text>
        <Text dimColor>({formatArgs(item.args)})</Text>
        {running && <Text dimColor> · running…</Text>}
      </Text>
      {preview.map((line, i) => (
        <Text key={i} dimColor={i < preview.length - 1}>
          {line.length > 160 ? line.slice(0, 160) + "…" : line}
        </Text>
      ))}
    </Box>
  );
}

/** One colored line of a unified diff (+ green, - red, @@ cyan, header bold). */
function DiffLine({ line }: { line: string }): React.JSX.Element {
  if (line.startsWith("+++") || line.startsWith("---")) return <Text bold>{line}</Text>;
  if (line.startsWith("@@")) return <Text color="cyan">{line}</Text>;
  if (line.startsWith("+")) return <Text color="green">{line}</Text>;
  if (line.startsWith("-")) return <Text color="red">{line}</Text>;
  return <Text>{line}</Text>;
}

const MAX_DIFF_RENDER_LINES = 24;

function DiffItemView({ item }: { item: Extract<ChatItem, { kind: "diff" }> }): React.JSX.Element {
  const lines = item.text.length > 0 ? item.text.split("\n") : [];
  const shown = lines.slice(0, MAX_DIFF_RENDER_LINES);
  const hidden = lines.length - shown.length;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text dimColor>{String(item.step).padStart(2, "0")}▸</Text>{" "}
        <Text color="magenta" bold>
          ✎
        </Text>{" "}
        <Text color="green">+{item.added}</Text> <Text color="red">-{item.removed}</Text>{" "}
        <Text bold>{item.path}</Text>
        {item.truncated && <Text color="yellow"> (diff truncated)</Text>}
      </Text>
      {shown.map((line, i) => (
        <DiffLine key={i} line={line.length > 160 ? line.slice(0, 160) + "…" : line} />
      ))}
      {hidden > 0 && <Text dimColor>… +{hidden} more diff lines</Text>}
    </Box>
  );
}

function ChatItemView({ item, spinner }: { item: ChatItem; spinner: string }): React.JSX.Element | null {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="blue" bold>
            ❯{" "}
          </Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={item.text ? 1 : 0} paddingLeft={1}>
          <Text dimColor={item.streaming}>{item.text || (item.streaming ? "" : "(no text)")}</Text>
        </Box>
      );
    case "tool":
      return <ToolItemView item={item} spinner={spinner} />;
    case "diff":
      return <DiffItemView item={item} />;
    case "build":
      return (
        <Box paddingLeft={1}>
          {item.success ? <Text color="green" bold>✔ build passed</Text> : <Text color="red" bold>✘ build failed</Text>}
          <Text dimColor> — {item.command}</Text>
        </Box>
      );
    case "notice":
      return (
        <Box paddingLeft={1}>
          <Text color={item.level === "error" ? "red" : item.level === "warn" ? "yellow" : "gray"}>
            {item.level === "error" ? "✘ " : "⚠ "}
            {item.text.length > 500 ? item.text.slice(0, 500) + "…" : item.text}
          </Text>
        </Box>
      );
  }
}

/** Build Rail — scoder's signature top bar: lamp + build command + fuel gauge. */
function BuildRail({ state, config }: { state: TuiState; config: AgentConfig }): React.JSX.Element {
  const lampColor = state.buildLamp === "ok" ? "green" : state.buildLamp === "fail" ? "red" : "gray";
  const lampLabel = state.buildLamp === "ok" ? "build ok" : state.buildLamp === "fail" ? "build fail" : "no build yet";
  const gauge = fuelGauge(state.step, state.maxSteps);
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text bold color="magenta">
        scoder
      </Text>
      <Text>
        <Text color={lampColor}>● {lampLabel}</Text>
        <Text dimColor> {state.buildCmd || config.buildCmd || "auto"}</Text>
      </Text>
      <Text>
        {gauge && (
          <>
            <Text color="magenta">{gauge}</Text>
            <Text dimColor> {state.step}/{state.maxSteps}</Text>
          </>
        )}
        {!gauge && <Text dimColor>— idle</Text>}
      </Text>
    </Box>
  );
}

function StatusBar({ state, spinner }: { state: TuiState; spinner: string }): React.JSX.Element {
  const statusColor = state.status === "running" ? "cyan" : state.status === "success" ? "green" : state.status === "failed" ? "red" : "gray";
  const statusLabel =
    state.status === "running" ? `running ${state.step}/${state.maxSteps}` : state.status === "idle" ? "idle" : state.status;
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text>
        <Text color={statusColor}>{state.status === "running" ? `${spinner} ${statusLabel}` : statusLabel}</Text>
        <Text dimColor> · {state.model || "—"}</Text>
        {state.usage.calls > 0 && (
          <Text dimColor>
            {" "}
            · tok {state.usage.inputTokens}/{state.usage.outputTokens}
            {state.usage.cachedTokens > 0 ? ` (+${state.usage.cachedTokens} cached)` : ""}
          </Text>
        )}
      </Text>
      <Text dimColor>⏎ send · pgup/pgdn scroll · esc abort · ctrl+c quit</Text>
    </Box>
  );
}

interface InputProps {
  /** Source of truth — updated synchronously by the parent (submit clears it
   *  before the next keystroke can arrive, so chunks never merge across a
   *  submit the way "/help" + "/cost" would become "/help/cost"). */
  valueRef: React.MutableRefObject<string>;
  /** Render mirror of valueRef.current. */
  value: string;
  onChange: (v: string) => void;
  /** Called with the final value (handles paste-with-newline chunks too). */
  onSubmit: (value: string) => void;
}

function Input({ valueRef, value, onChange, onSubmit }: InputProps): React.JSX.Element {
  useInput(
    (input, key) => {
      const current = valueRef.current;
      if (key.return) {
        onSubmit(current);
        return;
      }
      if (key.backspace || key.delete) {
        const next = current.slice(0, -1);
        valueRef.current = next;
        onChange(next);
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta && !key.escape && !key.upArrow && !key.downArrow && !key.tab) {
        // A chunk may contain several pasted chars — even a trailing newline
        // (terminal pastes / PTY writes deliver "exit\r" as one chunk).
        const parts = input.split(/[\r\n]+/);
        const next = current + parts[0];
        valueRef.current = next;
        onChange(next);
        if (parts.length > 1) onSubmit(next); // newline in the chunk = submit
      }
    },
    // Always active: typing while the agent runs is allowed (text is kept,
    // submit is a no-op until idle) so keystrokes are never silently lost.
  );
  return (
    <Box>
      <Text color="magenta" bold>
        {"❯ "}
      </Text>
      <Text>{value}</Text>
      <Text dimColor>▌</Text>
    </Box>
  );
}

export interface TuiAppProps {
  config: AgentConfig;
  initialTask: string | null;
  /** Shown as a notice in the chat pane on boot (e.g. the ask→auto fallback). */
  bootNotice?: string | null;
}

export function TuiApp({ config, initialTask, bootNotice }: TuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<TuiState>(initialState);
  const [input, setInput] = useState(initialTask ?? "");
  const [scrollOffset, setScrollOffset] = useState(0); // 0 = pinned to bottom
  const inputRef = useRef(initialTask ?? "");
  const writeInput = useCallback(
    (v: string) => {
      inputRef.current = v;
      setInput(v);
    },
    [],
  );
  const runningRef = useRef(false);
  const agentRef = useRef<Agent | null>(null);
  const spinner = useSpinner(state.status === "running");

  // Boot notice (e.g. "permission=ask is not supported in the TUI") as a chat
  // item, so it scrolls with the conversation instead of being lost off-screen.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (bootNotice) setState((s) => ({ ...s, items: [{ kind: "notice", text: bootNotice, level: "warn" }, ...s.items] }));
  }, [bootNotice]);

  const pushNotice = useCallback(
    (text: string, level: "info" | "warn" | "error" = "info") =>
      setState((s) => ({ ...s, items: [...s.items, { kind: "notice", text, level }] })),
    [],
  );

  const submit = useCallback(
    async (text: string) => {
      const task = text.trim();
      if (!task) return;
      // "exit"/"quit" always works — aborts a running agent first.
      if (task === "exit" || task === "quit") {
        agentRef.current?.abort();
        exit();
        return;
      }
      // Slash commands — handled by the UI itself, never sent to the LLM.
      const slash = parseSlashCommand(task);
      if (slash) {
        writeInput("");
        if (slash.cmd === "/exit" || slash.cmd === "/quit") {
          agentRef.current?.abort();
          exit();
          return;
        }
        if (slash.cmd === "/help") {
          pushNotice(formatSlashHelp("scoder tui"));
          return;
        }
        if (slash.cmd === "/clear") {
          agentRef.current?.abort();
          agentRef.current = null;
          runningRef.current = false;
          writeInput("");
          setScrollOffset(0);
          setState(initialState());
          return;
        }
        if (slash.cmd === "/cost") {
          const u = stateRef.current.usage;
          pushNotice(
            u.calls > 0
              ? `session usage: ${u.calls} LLM calls · tokens in ${u.inputTokens} / out ${u.outputTokens}` +
                  (u.cachedTokens > 0 ? ` (+${u.cachedTokens} cached)` : "")
              : "no LLM calls yet in this session",
          );
          return;
        }
        if (slash.cmd === "/model") {
          const s = stateRef.current;
          pushNotice(`model: ${s.model || config.model || "—"} · provider: ${s.provider || config.provider || "auto"}`);
          return;
        }
        pushNotice(`unknown command ${slash.cmd} — try /help`, "warn");
        return;
      }
      if (runningRef.current) return; // keep the typed text for when the agent is idle
      writeInput("");
      runningRef.current = true;
      setScrollOffset(0);
      // isFirst must be computed BEFORE pushing the user item below.
      const isFirst = stateRef.current.items.every((i) => i.kind !== "user");
      // runTurn() doesn't emit run_start, so the TUI shows the user's message
      // itself; applyEvent's run_start dedupe keeps turn 1 from doubling.
      setState((s) => ({ ...s, items: [...s.items, { kind: "user", text: task }], status: "running", summary: null }));

      let agent = agentRef.current;
      if (!agent) {
        agent = new Agent(config);
        // Functional updates: React feeds each updater the latest queued
        // state, so events can never land on a stale snapshot (a ref mirror
        // updated in useEffect races events arriving within one render batch
        // — tool results then miss their items and stay "running…" forever).
        agent.onEvent = (ev) =>
          setState((prev) => {
            const next = applyEvent(prev, ev);
            return { ...next, items: [...next.items] };
          });
        agentRef.current = agent;
      }
      try {
        // First submission runs the full closed loop; later ones continue the session.
        const result = isFirst ? await agent.run(task) : await agent.runTurn(task);
        void result;
        runningRef.current = false;
      } catch (err) {
        runningRef.current = false;
        setState((s) =>
          applyEvent({ ...s, items: [...s.items] }, { type: "error", message: (err as Error).message }),
        );
      }
    },
    [config, pushNotice, writeInput, exit],
  );

  // Mirror of state for the submit path (isFirst, /cost, /model) and the
  // abort handler — approximate between renders, exact whenever idle.
  const stateRef = useRef<TuiState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Esc aborts the running task (like SIGINT in the CLI); when scrolled up,
  // the first Esc returns to the bottom instead.
  const scrollOffsetRef = useRef(0);
  useEffect(() => {
    scrollOffsetRef.current = scrollOffset;
  }, [scrollOffset]);
  useInput((_input, key) => {
    if (key.pageUp) setScrollOffset((o) => Math.min(stateRef.current.items.length, o + 10));
    if (key.pageDown) setScrollOffset((o) => Math.max(0, o - 10));
    if (key.escape) {
      if (scrollOffsetRef.current > 0) {
        setScrollOffset(0);
        return;
      }
      if (runningRef.current) {
        setState((s) => ({ ...markAborted(s), items: [...s.items] }));
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
      setState((s) => ({ ...s, items: [...s.items, { kind: "notice", text: "Press Ctrl+C again to quit", level: "warn" }] }));
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

  // Scrollback viewport: by default pin to the newest items that fit on
  // screen; PgUp/PgDn moves the window over the flight-recorder log.
  const rows = stdout.rows ?? 24;
  const viewItems = Math.max(6, rows - 9);
  const total = state.items.length;
  const start = Math.max(0, Math.min(total - viewItems, total - viewItems - scrollOffset));
  const end = Math.max(start, Math.min(total, total - scrollOffset));
  const visible = state.items.slice(start, end);

  return (
    <Box flexDirection="column" height="100%">
      <BuildRail state={state} config={config} />
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {total === 0 && (
          <Text dimColor>
            Type a task and press Enter. The agent works autonomously until the build passes. (/help for commands)
          </Text>
        )}
        {scrollOffset > 0 && <Text dimColor>↑ scrollback — PgDn to return to the newest</Text>}
        {visible.map((item, i) => (
          <ChatItemView key={start + i} item={item} spinner={spinner} />
        ))}
        {state.status === "running" && state.step > 0 && (
          <Text dimColor>
            {spinner} step {state.step}/{state.maxSteps} — thinking…
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
      <Box paddingX={1}>
        <Input valueRef={inputRef} value={input} onChange={writeInput} onSubmit={(v) => void submit(v)} />
      </Box>
      <StatusBar state={state} spinner={spinner} />
    </Box>
  );
}

/** Mount the TUI (called from the `scoder tui` subcommand). */
export async function runTui(config: AgentConfig, initialTask: string | null): Promise<void> {
  setQuiet(true);
  // `ask` prompts via readline on stdin, which corrupts the alt-screen TUI
  // (same rule as `scoder serve`): fall back to auto with an in-pane notice.
  let bootNotice: string | null = null;
  if (config.permissionMode === "ask") {
    config = { ...config, permissionMode: "auto" };
    bootNotice = "permission=ask is not supported in the TUI — falling back to auto";
  }
  const { render } = await import("ink");
  const { waitUntilExit } = render(<TuiApp config={config} initialTask={initialTask} bootNotice={bootNotice} />);
  await waitUntilExit();
  // Ink restores the terminal on unmount; exit explicitly so provider
  // keep-alive sockets (undici pool) can't keep the event loop alive.
  process.exit(0);
}

