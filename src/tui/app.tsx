/**
 * Full-screen Ink TUI for scoder — an OpenCode-style terminal interface:
 * chat pane, live tool/diff feed, input line and status bar, driven entirely
 * by AgentEvents (the same stream the HTTP/SSE server exposes).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { AgentConfig } from "../config.js";
import { Agent } from "../agent.js";
import { setQuiet } from "../ui.js";
import { applyEvent, initialState, markAborted, type ChatItem, type TuiState } from "./state.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

const OUTPUT_PREVIEW_LINES = 4;

function ToolItemView({ item, spinner }: { item: Extract<ChatItem, { kind: "tool" }>; spinner: string }): React.JSX.Element {
  const running = item.ok === null;
  const icon = running ? <Text color="cyan">{spinner}</Text> : item.ok ? <Text color="green">✔</Text> : <Text color="red">✘</Text>;
  const lines = item.output.length > 0 ? item.output.replace(/\n+$/, "").split("\n") : [];
  const preview = lines.slice(-OUTPUT_PREVIEW_LINES);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        {icon} <Text color="cyan">{item.name}</Text>
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

function StatusBar({ state, spinner }: { state: TuiState; spinner: string }): React.JSX.Element {
  const statusColor = state.status === "running" ? "cyan" : state.status === "success" ? "green" : state.status === "failed" ? "red" : "gray";
  const statusLabel =
    state.status === "running" ? `running ${state.step}/${state.maxSteps}` : state.status === "idle" ? "idle" : state.status;
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
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
      <Text dimColor>⏎ send · esc abort · ctrl+c quit</Text>
    </Box>
  );
}

interface InputProps {
  value: string;
  onChange: (v: string) => void;
  /** Called with the final value (handles paste-with-newline chunks too). */
  onSubmit: (value: string) => void;
  disabled: boolean;
}

function Input({ value, onChange, onSubmit, disabled }: InputProps): React.JSX.Element {
  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta && !key.escape && !key.upArrow && !key.downArrow && !key.tab) {
        // A chunk may contain several pasted chars — even a trailing newline
        // (terminal pastes / PTY writes deliver "exit\r" as one chunk).
        const parts = input.split(/[\r\n]+/);
        const next = value + parts[0];
        onChange(next);
        if (parts.length > 1) onSubmit(next); // newline in the chunk = submit
      }
    },
    // Always active: typing while the agent runs is allowed (text is kept,
    // submit is a no-op until idle) so keystrokes are never silently lost.
  );
  return (
    <Box>
      <Text color="blue" bold>
        {"❯ "}
      </Text>
      <Text>{value}</Text>
      {!disabled && <Text dimColor>▌</Text>}
    </Box>
  );
}

export interface TuiAppProps {
  config: AgentConfig;
  initialTask: string | null;
}

export function TuiApp({ config, initialTask }: TuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [state, setState] = useState<TuiState>(initialState);
  const [input, setInput] = useState(initialTask ?? "");
  const inputRef = useRef(initialTask ?? "");
  const runningRef = useRef(false);
  const agentRef = useRef<Agent | null>(null);
  const spinner = useSpinner(state.status === "running");

  const setItemState = useCallback((next: TuiState) => setState({ ...next, items: [...next.items] }), []);

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
      if (runningRef.current) return; // keep the typed text for when the agent is idle
      setInput("");
      inputRef.current = "";
      runningRef.current = true;
      // isFirst must be computed BEFORE pushing the user item below.
      const isFirst = stateRef.current.items.every((i) => i.kind !== "user");
      // runTurn() doesn't emit run_start, so the TUI shows the user's message
      // itself; applyEvent's run_start dedupe keeps turn 1 from doubling.
      setState((s) => ({ ...s, items: [...s.items, { kind: "user", text: task }], status: "running", summary: null }));

      let agent = agentRef.current;
      if (!agent) {
        agent = new Agent(config);
        agent.onEvent = (ev) => setItemState(applyEvent(stateRef.current, ev));
        agentRef.current = agent;
        stateRef.current = initialState();
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
    [config, setItemState],
  );

  // Mirror of state for the event handler (setState inside onEvent would race).
  const stateRef = useRef<TuiState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Esc aborts the running task (like SIGINT in the CLI).
  useInput((_input, key) => {
    if (key.escape && runningRef.current) {
      markAborted(stateRef.current);
      setState((s) => ({ ...s, status: "aborted", summary: "abort requested…" }));
      agentRef.current?.abort();
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

  return (
    <Box flexDirection="column" height="100%">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">
          scoder
        </Text>
        <Text dimColor>
          {config.workdir.split("/").pop() || config.workdir} · build: {state.buildCmd || config.buildCmd || "auto"}
        </Text>
      </Box>
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {state.items.length === 0 && (
          <Text dimColor>
            Type a task and press Enter. The agent works autonomously until the build passes. ("exit" or Ctrl+C quits)
          </Text>
        )}
        {state.items.map((item, i) => (
          <ChatItemView key={i} item={item} spinner={spinner} />
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
        <Input value={input} onChange={setInput} onSubmit={(v) => void submit(v)} disabled={state.status === "running"} />
      </Box>
      <StatusBar state={state} spinner={spinner} />
    </Box>
  );
}

/** Mount the TUI (called from the `scoder tui` subcommand). */
export async function runTui(config: AgentConfig, initialTask: string | null): Promise<void> {
  setQuiet(true);
  // `ask` prompts via readline on stdin, which corrupts the alt-screen TUI
  // (same rule as `scoder serve`): fall back to auto with a warning.
  if (config.permissionMode === "ask") {
    config = { ...config, permissionMode: "auto" };
    console.log("⚠ permission=ask is not supported in the TUI — falling back to auto");
  }
  const { render } = await import("ink");
  const { waitUntilExit } = render(<TuiApp config={config} initialTask={initialTask} />);
  await waitUntilExit();
  // Ink restores the terminal on unmount; exit explicitly so provider
  // keep-alive sockets (undici pool) can't keep the event loop alive.
  process.exit(0);
}
