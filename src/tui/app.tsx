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
import { Box, Text, useApp, useWindowSize } from "ink";
import type { AgentConfig } from "../config/config.js";
import { Agent, type AgentEvent } from "../agent.js";
import { setQuiet } from "../io/terminal.js";
import { discoverSkills } from "../context/skills.js";
import { discoverAgents } from "../context/agents.js";
import { initialState, type TuiState } from "./state.js";
import { SLASH_COMMANDS, formatSlashHelp } from "../commands/definitions.js";
import { ChatItemView } from "./chat-views.js"; // T2
import { BuildRail, StatusBar, SIDEBAR_MIN_COLS } from "./chrome.js"; // T2
import { Input } from "./input.js"; // T2
import { SessionPicker } from "./session-picker.js"; // session picker modal
import { fileIndex } from "./at-complete.js";
import { getTheme, setActiveTheme, theme } from "./theme.js";
import { boxBorderStyle } from "./charset.js";
import { PermissionModal } from "./permission-modal.js"; // T2
import { Sidebar } from "./sidebar.js"; // sidebar opencode
import { getVersion } from "../shared/version.js";
import { useScrollMetrics } from "./hooks/use-scroll.js";
import { useEventQueue } from "./hooks/use-event-queue.js";
import { useSessionResume } from "./hooks/use-session-resume.js";
import { useCommandHost } from "./hooks/use-command-host.js";
import { useTuiKeybinds } from "./hooks/use-keybinds.js";
import { useSubmit } from "./hooks/use-submit.js";


export interface TuiAppProps {
  config: AgentConfig;
  initialTask: string | null;
}

export function TuiApp({ config, initialTask }: TuiAppProps): React.JSX.Element {
  // v2: the effective config can be hot-patched by slash commands (/agent,
  // /permission) — the prop is the initial value, cfg is the live one.
  const [cfg, setCfg] = useState(config);
  const { exit } = useApp();
  // T-09: theme resolve at mount (.scoder/theme.json > builtin). Proxy-based
  // theme reads re-render via a bump.
  const [, bump] = useState(0);
  const bumpFrame = useCallback(() => bump((n) => n + 1), []);
  useEffect(() => {
    setActiveTheme(getTheme(cfg.workdir));
    bumpFrame();
  }, [cfg.workdir, bumpFrame]);
  const [state, setState] = useState<TuiState>(initialState);
  const [input, setInput] = useState(initialTask ?? "");
  /** Rows scrolled up from the bottom; 0 = follow the newest content. */
  const [scrollOffset, setScrollOffset] = useState(0);
  const [permMode, setPermMode] = useState(cfg.permissionMode);
  // T-03: active permission prompt (modal) — the run blocks until answered.
  const [permPrompt, setPermPrompt] = useState<Extract<AgentEvent, { type: "permission_request" }> | null>(null);
  const permPromptRef = useRef(permPrompt);
  permPromptRef.current = permPrompt;
  // Session picker modal state (open via Ctrl+S)
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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

  // MCP connections live for the session (one connect, no per-message re-spawn).
  // Dispose on unmount so child server processes never outlive the TUI.
  useEffect(() => () => {
    agentRef.current?.dispose();
    agentRef.current = null;
  }, []);

  // ── Scrollable chat viewport (Ink 8 alt-screen) ──
  // The viewport clips overflow; the inner content wrapper keeps its natural
  // height so it can be measured and offset upward for scrolling.
  const { viewportRef, contentRef, viewport, content, viewportRowsRef } = useScrollMetrics(setScrollOffset);
  const maxScroll = Math.max(0, content.height - viewport.clientHeight);
  // scrollOffset counts rows UP from the bottom; 0 = follow the newest item.
  const scrollTop = Math.max(0, maxScroll - scrollOffset);

  const skills = useMemo(() => discoverSkills(cfg.workdir), [cfg.workdir]);
  const skillNames = useMemo(() => skills.map((s) => s.name), [skills]);
  // T-02: completion sources (agents + files) computed once per mount.
  const atSources = useMemo(
    () => ({
      skills: skillNames,
      agents: discoverAgents(cfg.workdir).filter((a) => a.mode !== "subagent" || a.name === "explore").map((a) => a.name),
      files: fileIndex(cfg.workdir),
    }),
    [cfg.workdir, skillNames],
  );

  // Mirror of state for the submit path (isFirst, /cost, /model) and the
  // abort handler — kept in sync synchronously by update(), so it is
  // exact even between renders (event bursts land between them).
  const { stateRef, update, queueEvent, eventQueue } = useEventQueue(state, setState, setPermPrompt, runningRef);
  const pushNotice = useCallback(
    (text: string, level: "info" | "warn" | "error" = "info") =>
      update((s) => ({ ...s, items: [...s.items, { kind: "notice", text, level }] })),
    [update],
  );

  const handleSessionSelect = useSessionResume({
    cfg, createAgent, pushNotice, update, runningRef, setScrollOffset, setSessionPickerOpen,
  });

  const tuiHost = useCommandHost({
    cfg, setCfg, update, agentRef, runningRef, eventQueue, setScrollOffset, setPermMode,
  });

  const { submit } = useSubmit({
    cfg, pushNotice, writeInput, exit, update, queueEvent, skills, skillNames, permMode,
    tuiHost, agentRef, runningRef, stateRef,
    historyRef, setScrollOffset, createAgent, bumpFrame,
  });

  /** Create (or return) the session agent — permission mode always current. */
  function createAgent(): Agent {
    if (agentRef.current) return agentRef.current;
    const agent = new Agent({ ...cfg, permissionMode: permMode });
    // Events go through the batching queue (see FLUSH_MS above): applyEvent
    // still receives the latest state because update() keeps stateRef in
    // sync synchronously — tool results can never miss their items.
    agent.onEvent = queueEvent;
    agentRef.current = agent;
    return agent;
  }

  useTuiKeybinds({
    scrollOffset, permPromptRef, setPermPrompt, agentRef, runningRef, sessionPickerOpen,
    setSessionPickerOpen, setPaletteOpen, inputRef, setHelpOpen, update, viewportRowsRef,
    setScrollOffset, exit,
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

  // The viewport renders items at full height so scroll math (content.height) is
  // always correct. Ink clips with overflow="hidden"; contentOffsetY shifts the
  // content column upward to reveal items above the current bottom.
  const { rows, columns } = useWindowSize();
  const showSidebar = (columns ?? 100) >= SIDEBAR_MIN_COLS;

  return (
    // flexShrink={0}: pinned chrome must never be squeezed when the chat
    // content overflows — Ink defaults every box to flexShrink:1, which
    // shrank the input bar to zero rows once the log outgrew the terminal.
    <Box flexDirection="column" height={rows || 24} flexShrink={0}>
      <BuildRail state={state} config={cfg} />
      {/* Hàng chính: chat bên trái (flexGrow) + Sidebar phải (cố định rộng).
          Clip overflow để BuildRail trên và Input + StatusBar dưới luôn pinned. */}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
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
          {state.items.length === 0 ? (
            <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
              {/* Big logo */}
              <Text bold color={theme.brand}>⚑ SCoder</Text>
              <Text dimColor>{`autonomous coding agent · v${getVersion()}`}</Text>
              <Text></Text>
              <Text dimColor>type a task to start — agent plans, edits, and builds</Text>
              <Text></Text>
              <Text dimColor>
                ⏎ send · <Text bold>ctrl+s</Text> sessions · tab complete · /help
              </Text>
            </Box>
          ) : (
            state.items.map((item, i) => <ChatItemView key={i} item={item} width={(columns ?? 100) - (showSidebar ? 42 : 4)} />)
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
        {/* Sidebar phải: plan live · tok/s · phases · build · MCP (narrow → ẩn). */}
        {showSidebar && <Sidebar state={state} config={cfg} />}
      </Box>
      {/* Session picker modal — Ctrl+S or bare "/" opens it. */}
      {sessionPickerOpen && (
        <SessionPicker
          workdir={cfg.workdir}
          onSelect={handleSessionSelect}
          onClose={() => setSessionPickerOpen(false)}
        />
      )}
      {paletteOpen && (
        <Box flexDirection="column" borderStyle={boxBorderStyle()} borderColor={theme.accent} paddingX={1} paddingY={1}>
          <Text color={theme.accent} bold>Command palette (Ctrl+P to close)</Text>
          {SLASH_COMMANDS.slice(0, 40).map((c) => (
            <Text key={c.cmd}>{c.cmd.padEnd(12)} {c.desc}</Text>
          ))}
        </Box>
      )}
      {helpOpen && (
        <Box flexDirection="column" borderStyle={boxBorderStyle()} borderColor={theme.dim} paddingX={1} paddingY={1}>
          <Text color={theme.brand} bold>Help (?)</Text>
          <Text>{formatSlashHelp("scoder tui")}</Text>
        </Box>
      )}
      {/* T-03: permission modal — blocks the run until answered. */}
      {permPrompt && <PermissionModal prompt={permPrompt} />}
      <Box paddingX={1} paddingTop={1} paddingBottom={1} flexShrink={0} alignSelf="stretch">
        <Input
          valueRef={inputRef}
          value={input}
          onChange={writeInput}
          onSubmit={(v) => void submit(v)}
          historyRef={historyRef}
          skillNames={skillNames}
          agentRef={agentRef}
          config={cfg}
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

