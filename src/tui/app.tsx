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
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { AgentConfig } from "../config.js";
import { Agent, type AgentEvent } from "../agent.js";
import { setQuiet } from "../ui.js";
import { discoverSkills } from "../skills.js";
import { applyEvent, initialState, markAborted, type ChatItem, type TuiState } from "./state.js";
import { completeSlashCommand, formatSlashHelp, parseSlashCommand } from "./commands.js";
import { Markdown } from "./markdown.js";
import { AgentMark, fit, theme, toolIcon } from "./theme.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;
/** Fuel gauge is scaled to this many cells regardless of maxSteps. */
const GAUGE_CELLS = 10;

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_MS);
    return () => clearInterval(timer);
  }, [active]);
  return SPINNER_FRAMES[frame];
}

/**
 * Isolated spinner: owns its own 80ms timer so animation frames re-render
 * ONLY this component — not the whole tree (the previous design lifted the
 * frame state into TuiApp, re-rendering every chat item 12x/second → flicker).
 */
function Spinner({ active }: { active: boolean }): React.JSX.Element | null {
  const frame = useSpinner(active);
  if (!active) return null;
  return <Text color="cyan">{frame}</Text>;
}

/** Scaled step fuel gauge: ▰ filled / ▱ remaining, e.g. ▰▰▰▰▱▱▱▱ 4/40. */
function fuelGauge(step: number, maxSteps: number): string | null {
  if (maxSteps <= 0) return null;
  const filled = Math.min(GAUGE_CELLS, Math.round((Math.min(step, maxSteps) / maxSteps) * GAUGE_CELLS));
  return "▰".repeat(filled) + "▱".repeat(GAUGE_CELLS - filled);
}

const OUTPUT_PREVIEW_LINES = 2;

/** Collapse run_command scaffolding ("--- stdout ---" etc.) to real content. */
function previewLines(output: string): string[] {
  const lines = output
    .replace(/\n+$/, "")
    .split("\n")
    .filter((l) => !/^--- (stdout|stderr) ---$/.test(l.trim()));
  return lines.slice(-OUTPUT_PREVIEW_LINES);
}

function ToolItemView({ item }: { item: Extract<ChatItem, { kind: "tool" }> }): React.JSX.Element {
  const running = item.ok === null;
  const icon = running ? <Spinner active /> : item.ok ? <Text color={theme.success}>✔</Text> : <Text color={theme.error}>✘</Text>;
  // One meaningful arg per tool type keeps the line scannable.
  const keyArg =
    typeof item.args.command === "string"
      ? fit(item.args.command, 48)
      : typeof item.args.path === "string"
        ? fit(item.args.path, 40)
        : Object.keys(item.args).length > 0
          ? fit(Object.keys(item.args).join(","), 24)
          : "";
  const preview = previewLines(item.output);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <Text dimColor>{String(item.step).padStart(2, "0")}▸ </Text>
        {icon} <Text color={theme.accent}>{toolIcon(item.name)} {item.name}</Text>
        {keyArg && <Text dimColor> {keyArg}</Text>}
        {running && <Text dimColor> …</Text>}
      </Text>
      {preview.map((line, i) => (
        <Text key={i} dimColor>
          {"  └ "}{line.length > 140 ? line.slice(0, 140) + "…" : line}
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      marginLeft={1}
    >
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

/** Live plan — checkbox list with per-status colors. */
function TodoItemView({ item }: { item: Extract<ChatItem, { kind: "todo" }> }): React.JSX.Element {
  const done = item.items.filter((t) => t.status === "completed").length;
  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={1}>
      <Text>
        <AgentMark />
        <Text bold>plan </Text>
        <Text dimColor>{done}/{item.items.length}</Text>
      </Text>
      {item.items.map((t, i) => (
        <Text key={i}>
          <Text> </Text>
          {t.status === "completed" ? (
            <>
              <Text color={theme.success}>✔ </Text>
              <Text color={theme.success} dimColor>{fit(t.content, 80)}</Text>
            </>
          ) : t.status === "in_progress" ? (
            <>
              <Text color={theme.accent}>◆ </Text>
              <Text color={theme.accent} bold>{fit(t.content, 80)}</Text>
            </>
          ) : (
            <>
              <Text dimColor>○ </Text>
              <Text dimColor>{fit(t.content, 80)}</Text>
            </>
          )}
        </Text>
      ))}
    </Box>
  );
}

function ChatItemView({ item }: { item: ChatItem }): React.JSX.Element | null {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={theme.user} bold>
            ❯{" "}
          </Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case "assistant": {
      // Finalized messages render as markdown; while streaming, raw dim text
      // (cheap — markdown layout of partial text would jump around anyway).
      if (item.streaming || !item.text) {
        return (
          <Box marginTop={item.text ? 1 : 0} paddingLeft={1}>
            <AgentMark />
            <Text dimColor={item.streaming}>{item.text || (item.streaming ? "" : "(no text)")}</Text>
          </Box>
        );
      }
      return (
        <Box marginTop={1} paddingLeft={1}>
          <AgentMark />
          <Markdown text={item.text} />
        </Box>
      );
    }
    case "tool":
      return <ToolItemView item={item} />;
    case "diff":
      return <DiffItemView item={item} />;
    case "todo":
      return <TodoItemView item={item} />;
    case "build":
      return (
        <Box paddingLeft={1}>
          {item.success ? <Text color={theme.success} bold>✔ build passed</Text> : <Text color={theme.error} bold>✘ build failed</Text>}
          <Text dimColor> — {item.command}</Text>
        </Box>
      );
    case "notice":
      return (
        <Box paddingLeft={1}>
          <Text color={item.level === "error" ? theme.error : item.level === "warn" ? theme.warn : theme.dim}>
            {item.level === "error" ? "✘ " : "⚠ "}
            {item.text.length > 500 ? item.text.slice(0, 500) + "…" : item.text}
          </Text>
        </Box>
      );
  }
}

/** Build Rail — scoder's signature top bar: badges + lamp + fuel gauge. */
function BuildRail({ state, config }: { state: TuiState; config: AgentConfig }): React.JSX.Element {
  const { stdout } = useStdout();
  const width = Math.max(40, (stdout.columns ?? 100) - 6); // usable inner width
  const lampColor = state.buildLamp === "ok" ? theme.success : state.buildLamp === "fail" ? theme.error : theme.dim;
  const lampLabel = state.buildLamp === "ok" ? "build ok" : state.buildLamp === "fail" ? "build fail" : "no build yet";
  const gauge = fuelGauge(state.step, state.maxSteps);
  const perm = state.permission || config.permissionMode;
  const model = state.model || config.model || "—";

  const right = gauge
    ? `${gauge} ${state.step}/${state.maxSteps}`
    : "— idle";
  const middle = `⛨ ${perm}  ● ${lampLabel}`;
  // Guarantee no overlap: shrink the model name first.
  const leftBudget = Math.max(8, width - right.length - middle.length - 4);
  return (
    <Box borderStyle="single" borderColor={theme.border} paddingX={1} justifyContent="space-between">
      <Text>
        <Text bold color={theme.brand}>scoder</Text>
        <Text dimColor> · {fit(model, leftBudget - "scoder · ".length)}</Text>
      </Text>
      <Text>
        <Text color={perm === "readonly" ? theme.warn : perm === "ask" ? theme.accent : theme.dim}>⛨ {perm}</Text>
        <Text> </Text>
        <Text color={lampColor}>● {lampLabel}</Text>
      </Text>
      <Text>
        {gauge && (
          <>
            <Text color={theme.brand}>{gauge}</Text>
            <Text dimColor> {state.step}/{state.maxSteps}</Text>
          </>
        )}
        {!gauge && <Text dimColor>— idle</Text>}
      </Text>
    </Box>
  );
}

function StatusBar({ state }: { state: TuiState }): React.JSX.Element {
  const { stdout } = useStdout();
  const width = Math.max(40, (stdout.columns ?? 100) - 6);
  const statusColor = state.status === "running" ? theme.accent : state.status === "success" ? theme.success : state.status === "failed" ? theme.error : theme.dim;
  const statusLabel =
    state.status === "running" ? `running ${state.step}/${state.maxSteps}` : state.status === "idle" ? "idle" : state.status;
  const model = state.model || "—";
  // Left: status · elapsed · model · tokens. Right: keybinds. Never overlap:
  // the left side is built from the whole budget minus the keybind block.
  const keybinds = "⏎ send · esc abort · ctrl+c quit";
  const leftBudget = Math.max(20, width - keybinds.length - 2);
  const elapsed = state.startedAt ? `${Math.floor((Date.now() - state.startedAt) / 60000)}:${String(Math.floor((Date.now() - state.startedAt) / 1000) % 60).padStart(2, "0")}` : null;
  let left = statusLabel + (state.status === "running" && elapsed ? ` · ${elapsed}` : "");
  const tokens = state.usage.calls > 0 ? ` · tok ${state.usage.inputTokens}/${state.usage.outputTokens}` : "";
  const modelPart = ` · ${model}`;
  if (left.length + modelPart.length + tokens.length <= leftBudget) left += modelPart + tokens;
  else if (left.length + modelPart.length <= leftBudget) left += modelPart;
  else left = fit(left, leftBudget);
  return (
    <Box borderStyle="single" borderColor={theme.border} paddingX={1} justifyContent="space-between">
      <Text>
        {state.status === "running" && <Spinner active />}
        {state.status === "running" ? " " : ""}
        <Text color={statusColor}>{left}</Text>
      </Text>
      <Text dimColor>{keybinds}</Text>
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
  const [permMode, setPermMode] = useState(config.permissionMode);
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
  const skills = useMemo(() => discoverSkills(config.workdir), [config.workdir]);
  const skillNames = useMemo(() => skills.map((s) => s.name), [skills]);

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

  // Boot notice (e.g. "permission=ask is not supported in the TUI") as a chat
  // item, so it scrolls with the conversation instead of being lost off-screen.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (bootNotice) update((s) => ({ ...s, items: [{ kind: "notice", text: bootNotice, level: "warn" }, ...s.items] }));
  }, [bootNotice, update]);

  const pushNotice = useCallback(
    (text: string, level: "info" | "warn" | "error" = "info") =>
      update((s) => ({ ...s, items: [...s.items, { kind: "notice", text, level }] })),
    [update],
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
          eventQueue.current = [];
          update(() => initialState());
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
        if (slash.cmd === "/skills") {
          if (skills.length === 0) {
            pushNotice("no skills discovered — add .scoder/skills/<name>/SKILL.md (name + description frontmatter)");
          } else {
            pushNotice(
              "Skills:\n" + skills.map((s) => `  ${s.name.padEnd(20)} ${s.description || "(no description)"} [${s.scope}]`).join("\n"),
            );
          }
          return;
        }
        if (slash.cmd === "/skill") {
          if (!slash.arg) {
            pushNotice(`usage: /skill <name>${skillNames.length ? ` — available: ${skillNames.join(", ")}` : ""}`, "warn");
            return;
          }
          const hit = skills.find((s) => s.name.toLowerCase() === slash.arg.toLowerCase());
          if (!hit) {
            pushNotice(`skill "${slash.arg}" not found — try /skills`, "warn");
            return;
          }
          const agent = agentRef.current ?? createAgent();
          const r = agent.stageSkill(hit.name);
          pushNotice(r.message, r.ok ? "info" : "error");
          return;
        }
        if (slash.cmd === "/mcp") {
          const agent = agentRef.current ?? createAgent();
          try {
            const status = await agent.mcpStatus();
            if (status.length === 0) {
              pushNotice("no MCP servers configured — add mcpServers to .scoderrc.json");
            } else {
              pushNotice(
                status
                  .map(
                    (srv) =>
                      `${srv.connected ? "✓" : "·"} ${srv.name} — ${srv.command}` +
                      (srv.connected ? ` (${srv.tools.length} tools)\n` + srv.tools.map((t) => `    mcp__${srv.name}__${t.name}`).join("\n") : " (not connected)"),
                  )
                  .join("\n"),
              );
            }
          } catch (err) {
            pushNotice(`MCP status failed: ${(err as Error).message}`, "error");
          }
          return;
        }
        if (slash.cmd === "/permission") {
          const mode = slash.arg.toLowerCase();
          if (!["auto", "readonly"].includes(mode)) {
            pushNotice(`permission: ${permMode} — usage: /permission <auto|readonly> (ask is not supported in the TUI)`, "warn");
            return;
          }
          setPermMode(mode as "auto" | "readonly");
          agentRef.current?.setPermissionMode(mode as "auto" | "readonly");
          update((s) => ({ ...s, permission: mode }));
          pushNotice(`permission mode → ${mode}`);
          return;
        }
        pushNotice(`unknown command ${slash.cmd} — try /help`, "warn");
        return;
      }
      if (runningRef.current) return; // keep the typed text for when the agent is idle
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
        update((s) => applyEvent({ ...s, items: [...s.items] }, { type: "error", message: (err as Error).message }));
      }
    },
    [config, pushNotice, writeInput, exit, update, queueEvent, skills, skillNames, permMode],
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
  useInput((_input, key) => {
    if (key.pageUp) setScrollOffset((o) => Math.min(stateRef.current.items.length, o + 10));
    if (key.pageDown) setScrollOffset((o) => Math.max(0, o - 10));
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

  // Scrollback viewport: by default pin to the newest items that fit on
  // screen; PgUp/PgDn moves the window over the flight-recorder log.
  const rows = stdout.rows ?? 24;
  const viewItems = Math.max(6, rows - 10);
  const total = state.items.length;
  const start = Math.max(0, Math.min(total - viewItems, total - viewItems - scrollOffset));
  const end = Math.max(start, Math.min(total, total - scrollOffset));
  const visible = state.items.slice(start, end);

  return (
    <Box flexDirection="column" height="100%">
      <BuildRail state={state} config={config} />
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {total === 0 ? (
          <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={1}>
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
        {scrollOffset > 0 && <Text dimColor>↑ scrollback — PgDn to return to the newest</Text>}
        {visible.map((item, i) => (
          <ChatItemView key={start + i} item={item} />
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
      <Box paddingX={1}>
        <Input
          valueRef={inputRef}
          value={input}
          onChange={writeInput}
          onSubmit={(v) => void submit(v)}
          historyRef={historyRef}
          skillNames={skillNames}
        />
      </Box>
      <StatusBar state={state} />
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
  /** Sent-message history for ↑/↓ recall. */
  historyRef: React.MutableRefObject<string[]>;
  /** Skill names for "/skill <Tab>" argument completion. */
  skillNames: string[];
}

function Input({ valueRef, value, onChange, onSubmit, historyRef, skillNames }: InputProps): React.JSX.Element {
  const histIdx = useRef<number | null>(null);
  const draft = useRef<string>("");

  useInput(
    (input, key) => {
      const current = valueRef.current;
      if (key.return) {
        histIdx.current = null;
        onSubmit(current);
        return;
      }
      // ↑/↓ message history recall
      if (key.upArrow || key.downArrow) {
        const hist = historyRef.current;
        if (hist.length === 0) return;
        if (histIdx.current === null) {
          if (key.downArrow) return;
          draft.current = current;
          histIdx.current = hist.length - 1;
        } else if (key.upArrow) {
          histIdx.current = Math.max(0, histIdx.current - 1);
        } else {
          histIdx.current += 1;
          if (histIdx.current >= hist.length) {
            histIdx.current = null;
            onChange(draft.current);
            valueRef.current = draft.current;
            return;
          }
        }
        const v = hist[histIdx.current];
        valueRef.current = v;
        onChange(v);
        return;
      }
      // Tab — complete slash command (and /skill argument)
      if (key.tab) {
        const argMatch = /^\/skill\s+(\S*)$/.exec(current);
        if (argMatch) {
          const partial = argMatch[1].toLowerCase();
          const hits = skillNames.filter((n) => n.toLowerCase().startsWith(partial));
          if (hits.length > 0) {
            const v = "/skill " + hits[0] + (hits.length === 1 ? " " : "");
            valueRef.current = v;
            onChange(v);
          }
          return;
        }
        const comp = completeSlashCommand(current);
        if (comp) {
          valueRef.current = comp.completed;
          onChange(comp.completed);
        }
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

  // Live candidates hint while a slash command is partially typed.
  const hint = value.startsWith("/") && !value.includes(" ") ? completeSlashCommand(value) : null;
  const candidates = hint && hint.candidates.length > 1 ? hint.candidates.map((c) => c.cmd).join("  ") : null;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="magenta" bold>
          {"❯ "}
        </Text>
        <Text>{value}</Text>
        <Text dimColor>▌</Text>
      </Box>
      {candidates && <Text dimColor>  {candidates}  (tab completes)</Text>}
    </Box>
  );
}
