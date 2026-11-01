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
import { listSessions, resolveSessionId } from "../session.js";
import { applyEvent, initialState, markAborted, type ChatItem, type TuiState } from "./state.js";
import { completeSlashCommand, completionProviders, ghostText, completeMcpArg, formatSlashHelp, parseMcpExec, parseSlashCommand } from "./commands.js";
import { applySuggestion, atQuery, fileIndex, suggest } from "./at-complete.js";
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
  const elapsed =
    item.durationMs != null
      ? item.durationMs >= 10_000
        ? `${(item.durationMs / 1000).toFixed(0)}s`
        : `${(item.durationMs / 1000).toFixed(1)}s`
      : null;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <Text dimColor>{String(item.step).padStart(2, "0")}▸ </Text>
        {icon} <Text color={theme.accent}>{toolIcon(item.name)} {item.name}</Text>
        {keyArg && <Text dimColor> {keyArg}</Text>}
        {running && <Text dimColor> …</Text>}
        {elapsed && <Text dimColor> ({elapsed})</Text>}
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
            {item.streaming && <Text color={theme.accent}>▋</Text>}
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
            {item.text.length > 2000 ? item.text.slice(0, 2000) + "…" : item.text}
          </Text>
        </Box>
      );
  }
}

/** Build Rail — scoder's signature top bar: badges + lamp + fuel gauge. */
function BuildRail({ state, config }: { state: TuiState; config: AgentConfig }): React.JSX.Element {
  const { columns } = useWindowSize();
  const width = Math.max(40, (columns ?? 100) - 6); // usable inner width
  const lampColor = state.buildLamp === "ok" ? theme.success : state.buildLamp === "fail" ? theme.error : theme.dim;
  const lampLabel = state.buildLamp === "ok" ? "build ok" : state.buildLamp === "fail" ? "build fail" : "no build yet";
  const gauge = fuelGauge(state.step, state.maxSteps);
  const perm = state.permission || config.permissionMode;
  const model = state.model || config.model || "—";

  const right = gauge ? `${gauge} ${state.step}/${state.maxSteps}` : "— idle";
  const lamp = `● ${lampLabel}`;
  // Hàng 1: brand · model | ⛨ perm · ● lamp | gauge. MCP chỉ đếm số (tên xem qua /mcp).
  const mcpNames = Object.keys(config.mcpServers ?? {});
  const mcpLabel = mcpNames.length > 0 ? ` · mcp×${mcpNames.length}` : "";
  const leftBudget = Math.max(8, width - right.length - lamp.length - 12);
  // Hàng phụ chỉ hiện khi run đang hoạt động — idle giữ nguyên một hàng (minimalism).
  const showSecondRow = state.status === "running" || state.phases.length > 0;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1} flexShrink={0}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={theme.brand}>scoder</Text>
          <Text dimColor> · {fit(model, Math.max(4, leftBudget - "scoder · ".length))}</Text>
          {mcpLabel && <Text color={theme.accent}>{mcpLabel}</Text>}
        </Text>
        <Text>
          <Text color={perm === "readonly" ? theme.warn : perm === "ask" ? theme.accent : theme.dim}>⛨ {perm}</Text>
          <Text> </Text>
          <Text color={lampColor}>{lamp}</Text>
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
      {showSecondRow && (
        <Box justifyContent="space-between">
          <PhaseBreadcrumb phases={state.phases} />
          <LiveMetrics state={state} />
        </Box>
      )}
      {showSecondRow && state.lastGuardrail && <GuardrailNotice text={state.lastGuardrail} />}
    </Box>
  );
}

/** Breadcrumb tiến trình: plan › explore › edit › build › verify. */
const PHASE_SEQUENCE = ["plan", "explore", "edit", "build", "verify"] as const;

function PhaseBreadcrumb({ phases }: { phases: string[] }): React.JSX.Element {
  const current = phases[phases.length - 1] ?? null;
  return (
    <Text>
      {PHASE_SEQUENCE.map((p, i) => {
        const visited = phases.includes(p);
        const isCurrent = p === current;
        return (
          <Text key={p}>
            {i > 0 && <Text dimColor> › </Text>}
            <Text color={isCurrent ? theme.accent : visited ? theme.success : theme.dim} bold={isCurrent}>
              {p}
            </Text>
          </Text>
        );
      })}
    </Text>
  );
}

/** Metrics sống bên phải breadcrumb: tokens (in/out · tok/s) · elapsed · guardrails. */
function LiveMetrics({ state }: { state: TuiState }): React.JSX.Element {
  const parts: string[] = [];
  if (state.usage.calls > 0) {
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    let tok = `tok ${fmt(state.usage.inputTokens)}→${fmt(state.usage.outputTokens)}`;
    // tok/s: output tokens / elapsed seconds của run.
    if (state.startedAt) {
      const s = ((state.endedAt ?? Date.now()) - state.startedAt) / 1000;
      if (s > 0.5) tok += ` · ${fmt(Math.round(state.usage.outputTokens / s))} tok/s`;
    }
    parts.push(tok);
  }
  if (state.startedAt) {
    const s = Math.floor(((state.endedAt ?? Date.now()) - state.startedAt) / 1000);
    parts.push(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  }
  if (state.guardrailCount > 0) {
    parts.push(`guardrails ${state.guardrailCount}`);
  }
  if (parts.length === 0) return <Text dimColor>starting…</Text>;
  return <Text dimColor>{parts.join(" · ")}</Text>;
}

/** Guardrail can thiệp gần nhất — hàng riêng, văn bản tự giải thích, không nhồi vào hàng metrics. */
function GuardrailNotice({ text }: { text: string }): React.JSX.Element | null {
  return <Text color={theme.warn}>⚠ agent reminder: {text}</Text>;
}

function StatusBar({ state, scroll }: { state: TuiState; scroll?: string | null }): React.JSX.Element {
  const { columns } = useWindowSize();
  const width = Math.max(40, (columns ?? 100) - 6);
  const statusColor = state.status === "running" ? theme.accent : state.status === "success" ? theme.success : state.status === "failed" ? theme.error : theme.dim;
  const statusLabel =
    state.status === "running" ? `running ${state.step}/${state.maxSteps}` : state.status === "idle" ? "idle" : state.status;
  const model = state.model || "—";
  // Left: status · elapsed · model. Right: scroll position or keybinds.
  // (Tokens live in the header metrics row only — no duplicated display here.)
  const keybinds = scroll ? `↑ scrollback ${scroll} · ⏎ send · ctrl+c quit` : "⏎ send · pgup history · esc abort · ctrl+c quit";
  const leftBudget = Math.max(20, width - keybinds.length - 2);
  const elapsed = state.startedAt ? `${Math.floor((Date.now() - state.startedAt) / 60000)}:${String(Math.floor((Date.now() - state.startedAt) / 1000) % 60).padStart(2, "0")}` : null;
  let left = statusLabel + (state.status === "running" && elapsed ? ` · ${elapsed}` : "");
  const modelPart = ` · ${model}`;
  if (left.length + modelPart.length <= leftBudget) left += modelPart;
  else left = fit(left, leftBudget);
  return (
    <Box borderStyle="single" borderColor={theme.border} paddingX={1} justifyContent="space-between" flexShrink={0}>
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
}

export function TuiApp({ config, initialTask }: TuiAppProps): React.JSX.Element {
  const { exit } = useApp();
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
  const reviewRef = useRef<{
    stage: "level" | "selection";
    tool: string;
    argsBase: Record<string, unknown>;
    rewrittenPrompt?: string;
  } | null>(null);
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

  /** One round of the /review state machine: call the gate, render the result. */
  const reviewStep = useCallback(
    async (tool: string, args: Record<string, unknown>) => {
      const agent = agentRef.current ?? createAgent();
      reviewBusyRef.current = true;
      try {
        const r = await agent.callMcpTool(tool, args);
        const sc = (r.structured ?? {}) as Record<string, unknown>;
        const status = typeof sc.status === "string" ? sc.status : null;
        if (!r.ok) {
          reviewRef.current = null;
          pushNotice(`prompt gate error: ${r.output.slice(0, 500)}`, "error");
          return;
        }
        if (status === "pending_level_selection") {
          reviewRef.current = { stage: "level", tool, argsBase: args };
          pushNotice(
            "Which rewrite level?\n  [1] light — minimal, close to original\n  [2] balanced — structure + context + criteria\n  [3] detailed — full spec with acceptance criteria\nReply 1, 2 or 3.",
          );
        } else if (status === "pending_user_selection") {
          const rewritten = typeof sc.rewritten_prompt === "string" ? sc.rewritten_prompt : "";
          reviewRef.current = { stage: "selection", tool, argsBase: args, rewrittenPrompt: rewritten };
          pushNotice(
            `--- ORIGINAL ---\n${String(sc.original_prompt ?? "(missing)")}\n\n--- REWRITTEN ---\n${rewritten}\n\nWhich should be used?\n  [1] original\n  [2] rewritten\n  [3] update — describe changes, rewrite again\n  [4] cancel\nReply 1-4 (or 3 + your changes).`,
          );
        } else if (status === "approved") {
          reviewRef.current = null;
          pushNotice(`✔ prompt approved:\n${String(sc.selected_prompt ?? "")}`);
        } else if (status === "cancelled") {
          reviewRef.current = null;
          pushNotice("⏹ prompt gate cancelled — nothing approved.");
        } else {
          reviewRef.current = null;
          pushNotice(`prompt gate: unexpected status ${status ?? "(none)"}\n${r.output.slice(0, 500)}`, "warn");
        }
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
      const m = /^([1-4])(?:\s+([\s\S]+))?$/.exec(text.trim());
      if (rv.stage === "level") {
        if (!m) {
          pushNotice("reply 1, 2 or 3 to pick the rewrite level", "warn");
          return true;
        }
        const levels = ["light", "balanced", "detailed"];
        void reviewStep(rv.tool, { ...rv.argsBase, rewrite_level: levels[Number(m[1]) - 1] });
        return true;
      }
      // stage === "selection"
      if (!m) {
        pushNotice("reply 1-4 (or 3 + your requested changes)", "warn");
        return true;
      }
      const n = m[1];
      if (n === "3") {
        const feedback = m[2]?.trim();
        if (!feedback) {
          pushNotice("update needs your requested changes: 3 <what to change>", "warn");
          return true;
        }
        void reviewStep(rv.tool, {
          ...rv.argsBase,
          selection: "update",
          feedback,
          rewritten_prompt: rv.rewrittenPrompt,
        });
        return true;
      }
      const selection = n === "1" ? "original" : n === "2" ? "rewritten" : "cancel";
      void reviewStep(rv.tool, {
        ...rv.argsBase,
        selection,
        ...(selection === "rewritten" ? { rewritten_prompt: rv.rewrittenPrompt } : {}),
      });
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
      // Slash commands — handled by the UI itself, never sent to the LLM.
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
          // T-06: /diff turn | session | branch (default: turn).
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
        if (slash.cmd === "/exit" || slash.cmd === "/quit") {
          agentRef.current?.abort();
          exit();
          return;
        }
        if (slash.cmd === "/sessions") {
          // T-05: list + resume. Bare → list; "/sessions resume <id|last>" →
          // restore messages into a fresh agent and continue in this TUI.
          if (slash.arg.startsWith("resume")) {
            const ref = slash.arg.replace(/^resume\s*/, "").trim() || "last";
            const s = resolveSessionId(config.workdir, ref);
            if (!s) {
              pushNotice(`session not found: ${ref} — bare /sessions lists saved ones`, "error");
              return;
            }
            if (runningRef.current) {
              pushNotice("agent is running — wait or Esc first", "warn");
              return;
            }
            agentRef.current?.abort();
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
            return;
          }
          const all = listSessions(config.workdir);
          pushNotice(
            all.length === 0
              ? "no saved sessions — completed runs auto-save to .scoder/sessions/"
              : all.slice(0, 10).map((x) => `${x.id.slice(0, 8)}  ${x.updatedAt.slice(0, 16).replace("T", " ")}  ${x.steps} steps  ${x.task}`).join("\n") + "\nresume: /sessions resume <id|last>",
          );
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
          const agent = agentRef.current;
          if (slash.arg) {
            // T-04: hot-swap — "openai/gpt-4o-mini" or bare "gpt-4o-mini".
            const agent2 = agent ?? createAgent();
            const notice = agent2.setModel(slash.arg.trim());
            pushNotice(notice, notice.startsWith("ERROR") ? "error" : "info");
          } else {
            const s = stateRef.current;
            pushNotice(`model: ${s.model || config.model || "—"} · provider: ${s.provider || config.provider || "auto"} — switch: /model <provider/model>`);
          }
          return;
        }
        if (slash.cmd === "/skills") {
          if (skills.length === 0) {
            pushNotice("no skills discovered — add .scoder/skills/<name>/SKILL.md (name + description frontmatter)");
          } else {
            pushNotice(
              "Skills:\n" +
                skills
                  .map((s) => `  ${s.name.padEnd(26)} ${fit(s.description || "(no description)", 72)} [${s.scope}]`)
                  .join("\n"),
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
          const exec = parseMcpExec(slash.arg);
          if (exec === null) {
            // list mode
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
          if ("error" in exec) {
            pushNotice(exec.error, "warn");
            return;
          }
          // exec mode — call one MCP tool directly (long calls stream nothing; show busy notice first)
          pushNotice(`→ ${exec.fullName} …`);
          try {
            const r = await agent.callMcpTool(exec.fullName, exec.args);
            pushNotice(
              r.ok
                ? `${exec.fullName} →\n${r.output.length > 2000 ? r.output.slice(0, 2000) + "… (truncated)" : r.output}`
                : r.output,
              r.ok ? "info" : "error",
            );
          } catch (err) {
            pushNotice(`MCP exec failed: ${(err as Error).message}`, "error");
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
        pushNotice(`unknown command ${slash.cmd} — try /help`, "warn");
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
    [config, pushNotice, writeInput, exit, update, queueEvent, skills, skillNames, permMode, reviewAnswer, reviewStep],
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

  // The viewport renders ALL items (state.ts caps at 400) and scrolls with
  // contentOffsetY — real pixel-accurate scrollback with a sticky frame.
  // Perf cap: render at most the last RENDER_CAP items — older items stay in
  // state (scrolling only covers this window) so long runs keep Ink fast.
  const { rows } = useWindowSize();
  const RENDER_CAP = 200;
  const total = state.items.length;
  const visible = total > RENDER_CAP ? state.items.slice(-RENDER_CAP) : state.items;

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
      {permPrompt && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>
            ⚠ permission required — {permPrompt.kind}
          </Text>
          <Text>{permPrompt.label}</Text>
          {permPrompt.diff && (
            <Box flexDirection="column" marginTop={1}>
              {permPrompt.diff.split("\n").slice(0, 12).map((l, i) => (
                <Text key={i} color={l.startsWith("+") ? "green" : l.startsWith("-") ? "red" : undefined}>
                  {l}
                </Text>
              ))}
              {permPrompt.diff.split("\n").length > 12 && <Text dimColor>… (truncated)</Text>}
            </Box>
          )}
          <Text dimColor>
            [y] yes · [a] always · [n] no · [q] quit — timeout {permPrompt.timeoutSecs}s ⇒ deny
          </Text>
        </Box>
      )}
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
  /** Agent ref — /mcp Tab completion reads mcpStatus() lazily (servers + tools). */
  agentRef: React.MutableRefObject<Agent | null>;
  /** Workdir for the @ file index (T-01). */
  config: AgentConfig;
  /** T-02: completion sources (skills/agents/files). */
  atSources: { skills: string[]; agents: string[]; files: string[] };
  /** T-03: when set, the permission modal owns the keyboard. */
  modalRef: React.MutableRefObject<unknown>;
}

function Input({ valueRef, value, onChange, onSubmit, historyRef, skillNames, agentRef, config, atSources, modalRef }: InputProps): React.JSX.Element {
  const histIdx = useRef<number | null>(null);
  const draft = useRef<string>("");

  // ── T-01: `@` fuzzy file autocomplete ──────────────────────────────────────
  // Overlay state kept out of React re-render hot path: suggestions are sync
  // (fuzzysort over cached index ≤5s TTL) so we can compute inside useInput.
  const [atState, setAtState] = useState<{ at: { start: number; query: string }; suggestions: string[]; idx: number } | null>(null);
  const atStateRef = useRef(atState);
  const workdir = config?.workdir ?? process.cwd();
  const refreshAt = useCallback(
    (v: string) => {
      const at = atQuery(v);
      if (!at) {
        if (atStateRef.current) {
          atStateRef.current = null;
          setAtState(null);
        }
        return;
      }
      const suggestions = suggest(fileIndex(workdir), at.query);
      const prev = atStateRef.current;
      // Keep selection when the query narrows (still points at same entry).
      const idx = prev && prev.at.start === at.start && suggestions[prev.idx] === prev.suggestions[prev.idx] ? prev.idx : 0;
      const next = suggestions.length > 0 ? { at, suggestions, idx } : null;
      atStateRef.current = next;
      setAtState(next);
    },
    [workdir],
  );
  const acceptAt = useCallback(
    (sel: string | undefined) => {
      const st = atStateRef.current;
      if (!st || sel === undefined) return;
      const v = applySuggestion(valueRef.current, st.at, sel);
      valueRef.current = v;
      onChange(v);
      atStateRef.current = null;
      setAtState(null);
    },
    [onChange, valueRef],
  );

  useInput(
    (input, key) => {
      if (modalRef.current) return; // T-03: modal owns the keyboard
      const current = valueRef.current;
      // T-01: Esc closes the @ overlay (before submit semantics).
      if (key.escape) {
        if (atStateRef.current) {
          atStateRef.current = null;
          setAtState(null);
        }
        return;
      }
      if (key.return) {
        histIdx.current = null;
        onSubmit(current);
        return;
      }
      // ↑/↓ message history recall — but T-01 @ overlay takes precedence.
      if (key.upArrow || key.downArrow) {
        if (atStateRef.current) {
          const st = atStateRef.current;
          const idx = key.upArrow ? Math.max(0, st.idx - 1) : Math.min(st.suggestions.length - 1, st.idx + 1);
          const next = { ...st, idx };
          atStateRef.current = next;
          setAtState(next);
          return;
        }
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
      // Tab — complete slash command (and /skill, /mcp arguments)
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
        if (/^\/mcp\s/.test(current)) {
          // /mcp completion cần danh sách server/tools — async qua mcpStatus().
          const agent = agentRef.current;
          if (agent) {
            void agent.mcpStatus().then((servers) => {
              const v = completeMcpArg(current, servers);
              if (v) {
                valueRef.current = v;
                onChange(v);
              }
            });
          }
          return;
        }
        // T-02: Tab accepts ghost text (unique candidate extension).
        if (!atStateRef.current && ghostRef.current) {
          const v = ghostRef.current.insert;
          valueRef.current = v;
          onChange(v);
          return;
        }
        // T-01: Tab accepts the active @ suggestion (dirs keep trailing slash).
        if (atStateRef.current) {
          acceptAt(atStateRef.current.suggestions[atStateRef.current.idx]);
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
        refreshAt(next);
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta && !key.escape && !key.upArrow && !key.downArrow && !key.tab) {
        // A chunk may contain several pasted chars — even a trailing newline
        // (terminal pastes / PTY writes deliver "exit\r" as one chunk).
        const parts = input.split(/[\r\n]+/);
        const next = current + parts[0];
        valueRef.current = next;
        onChange(next);
        refreshAt(next);
        if (parts.length > 1) onSubmit(next); // newline in the chunk = submit
      }
    },
    // Always active: typing while the agent runs is allowed (text is kept,
    // submit is a no-op until idle) so keystrokes are never silently lost.
  );

  // Live candidates hint while a slash command is partially typed.
  const hint = value.startsWith("/") && !value.includes(" ") ? completeSlashCommand(value) : null;
  const candidates = hint && hint.candidates.length > 1 ? hint.candidates.map((c) => c.cmd).join("  ") : null;
  const at = atState;
  // T-02 ghost text: unique extension of the last token, dim after cursor.
  const providers = useMemo(() => completionProviders(atSources), [atSources]);
  const ghost = useMemo(() => (atState ? null : ghostText(value, providers)), [value, providers, atState]);
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  return (
    <Box flexDirection="column">
      {at && (
        <Box flexDirection="column" paddingLeft={2}>
          {at.suggestions.map((s, i) => (
            <Text key={s} color={i === at.idx ? theme.brand : undefined} bold={i === at.idx}>
              {i === at.idx ? "▸ " : "  "}
              {s}
            </Text>
          ))}
          <Text dimColor>  ↑/↓ select · tab/enter accept · esc close</Text>
        </Box>
      )}
      <Box>
        <Text color="magenta" bold>
          {"❯ "}
        </Text>
        <Text>{value}</Text>
        {ghost && <Text dimColor>{ghost.rest}</Text>}
        <Text dimColor>▌</Text>
      </Box>
      {candidates && <Text dimColor>  {candidates}  (tab completes)</Text>}
    </Box>
  );
}
