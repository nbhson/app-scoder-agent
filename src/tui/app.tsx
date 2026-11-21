/**
 * Full-screen Ink TUI for scoder — "mission control for the build loop".
 *
 * Identity (deliberately distinct from chat-first agent UIs): the build is
 * the mission, so the screen is organized around it —
 *   · Build Rail (top): brand, permission badge, build lamp
 *   · Sidebar (right panel): session · MCP · metrics · phases · plan · build
 *   · Flight-recorder log: each tool entry is stamped `07 ▸ name(args)`
 *   · `✎` diff cards rendered inline for every file edit
 *   · Assistant messages render as markdown (code fences, headers, lists)
 *   · Input: ↑/↓ history · Tab command completion · live candidates hint
 * Driven entirely by AgentEvents (the same stream the HTTP/SSE server uses).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useWindowSize } from "ink";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../config/config.js";
import { Agent, type AgentEvent } from "../agent.js";
import { setQuiet } from "../io/terminal.js";
import { discoverSkills } from "../context/skills.js";
import { discoverAgents, selectableAgents, subagentDefs } from "../context/agents.js";
import { initialState, type TuiState } from "./state.js";
import { transcriptWindow, estimateTotalRows } from "./selectors.js";
import { formatSlashHelp, nextInCycle, AGENT_CYCLE, PERMISSION_CYCLE, discoverCustomCommands } from "../commands/definitions.js";
import { dispatchCommand } from "../commands/registry.js";
import { ChatItemView } from "./chat-views.js"; // T2
import { BuildRail, StatusBar, SIDEBAR_MIN_COLS, SIDEBAR_WIDTH } from "./chrome.js"; // T2
import { Input } from "./input.js"; // T2
import { SessionPicker } from "./session-picker.js"; // session picker modal
import { Palette } from "./palette.js"; // command palette (Ctrl+P)
import { Pager, pagerSources, type PagerSource } from "./pager.js"; // full-screen viewer (A4)
import { fileIndex } from "./at-complete.js";
import { newContentPill, scrollThumb } from "./scrollbar.js"; // A5 scroll affordances
import { getTheme, setActiveTheme, theme } from "./theme.js";
import { boxBorderStyle, charset, isAsciiMode } from "./charset.js";
import { PermissionModal } from "./permission-modal.js"; // T2
import { Sidebar } from "./sidebar.js"; // sidebar opencode
import { getVersion } from "../shared/version.js";
import { useScrollMetrics } from "./hooks/use-scroll.js";

/**
 * Logo lớn cho màn hình welcome (block letters, ~49 cols) — chỉ vẽ khi pane
 * chat đủ rộng, ngược lại fallback dòng "⚑ SCoder". ASCII mode: biến thể '#'.
 */
const BANNER = [
  "███████╗ ██████╗ ██████╗ ██████╗ ███████╗██████╗ ",
  "██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗",
  "███████╗██║     ██║   ██║██║  ██║█████╗  ██████╔╝",
  "╚════██║██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗",
  "███████║╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║",
  "╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];
const BANNER_ASCII = [
  "#####   ####   ####  #####  ###### ##### ",
  "#      #      #    # #    # #      #    #",
  "#####  #      #    # #    # ####   ##### ",
  "     # #      #    # #    # #      #   # ",
  "#####   ####   ####  #####  ###### #    #",
];
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
  // T-09: theme resolve at mount (.scoder/theme.json > env > rc "theme" >
  // builtin). Proxy-based theme reads re-render via a bump.
  const [, bump] = useState(0);
  const bumpFrame = useCallback(() => bump((n) => n + 1), []);
  useEffect(() => {
    setActiveTheme(getTheme(cfg.workdir, cfg.theme));
    bumpFrame();
  }, [cfg.workdir, cfg.theme, bumpFrame]);
  const [state, setState] = useState<TuiState>(initialState);
  const [input, setInput] = useState(initialTask ?? "");
  /** Rows scrolled up from the bottom; 0 = follow the newest content. */
  const [scrollOffset, setScrollOffset] = useState(0);
  /** Ctrl+O: native terminal text selection (mouse tracking released). */
  const [selectMode, setSelectMode] = useState(false);
  const [permMode, setPermMode] = useState(cfg.permissionMode);
  // T-03: active permission prompt (modal) — the run blocks until answered.
  const [permPrompt, setPermPrompt] = useState<Extract<AgentEvent, { type: "permission_request" }> | null>(null);
  const permPromptRef = useRef(permPrompt);
  permPromptRef.current = permPrompt;
  // Session picker modal state (open via Ctrl+S)
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // A4: full-screen viewer open — index into state.items of the source row,
  // or null. Wheel routing goes through pagerWheelRef (useScrollMetrics
  // override) so scrolling the transcript never fights the pager.
  const [pagerAt, setPagerAt] = useState<number | null>(null);
  const pagerWheelRef = useRef<((dir: "up" | "down") => void) | null>(null);
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

  // ── Scrollable chat viewport (Ink 8 alt-screen) — P1-8 virtualized ──
  // Chi phí layout/wrap mỗi frame tỷ lệ với số item MOUNT, không phải số
  // item transcript ⇒ chỉ mount cửa sổ quanh viewport (transcriptWindow).
  // Scroll offset khi đọc lại dùng rows ước lượng; khi BÁM ĐÁY dùng chiều
  // cao THẬT của cửa sổ đã mount (đo rẻ vì cửa sổ ~viewport+overscan) —
  // estimate sai lệch bao nhiêu thì dòng cuối vẫn luôn thấy.
  const { viewportRef, viewport, contentRef, content, viewportRowsRef } = useScrollMetrics(setScrollOffset, !selectMode, pagerWheelRef);
  const viewportRows = viewport.clientHeight || 24;
  const win = useMemo(() => {
    const total = estimateTotalRows(state.items);
    const max = Math.max(0, total - viewportRows);
    const top = Math.max(0, max - scrollOffset);
    return { ...transcriptWindow(state.items, top, viewportRows), maxScroll: max };
  }, [state.items, scrollOffset, viewportRows]);
  const maxScroll = win.maxScroll;
  // A5 pill: baseline = row count captured the moment the user scrolled up;
  // growth after that is "new content behind you". Cleared at the bottom.
  const scrollBaseRowsRef = useRef<number | null>(null);
  if (scrollOffset === 0) scrollBaseRowsRef.current = null;
  else if (scrollBaseRowsRef.current == null) scrollBaseRowsRef.current = win.totalRows;
  const newRowsPill = newContentPill(scrollBaseRowsRef.current ?? win.totalRows, win.totalRows, scrollOffset);
  // A5 thumb: a 1-column proportional scrollbar on the chat pane's right
  // edge; off in select mode (the rail would be copied as text).
  const thumb = selectMode ? null : scrollThumb(viewport.clientHeight || 0, win.totalRows, scrollOffset);
  // Follow-bottom (scrollOffset = 0): offset chính xác theo số đo thật.
  const contentOffset =
    scrollOffset === 0 && content.hasMeasured
      ? Math.max(0, content.height - viewport.clientHeight)
      : win.offset;

  const skills = useMemo(() => discoverSkills(cfg.workdir), [cfg.workdir]);
  const skillNames = useMemo(() => skills.map((s) => s.name), [skills]);
  // T-02: completion sources (agents + files) computed once per mount.
  const atSources = useMemo(
    () => ({
      skills: skillNames,
      agents: subagentDefs(discoverAgents(cfg.workdir)).map((a) => a.name),
      files: fileIndex(cfg.workdir),
    }),
    [cfg.workdir, skillNames],
  );
  // P2: palette catalog sources + keyboard ownership. While ANY overlay is
  // open the overlay owns the keyboard — Input and the global keybinds are
  // gated off through overlayRef (the picker used to leak keystrokes into
  // the input field underneath it).
  const customCmds = useMemo(() => discoverCustomCommands(cfg.workdir), [cfg.workdir]);
  const agentNames = useMemo(() => selectableAgents(cfg.workdir).map((a) => a.name), [cfg.workdir]);
  const overlayRef = useRef<unknown>(null);

  // Mirror of state for the submit path (isFirst, /cost, /model) and the
  // abort handler — kept in sync synchronously by update(), so it is
  // exact even between renders (event bursts land between them).
  const { stateRef, update, queueEvent, eventQueue } = useEventQueue(state, setState, setPermPrompt, runningRef);
  const pushNotice = useCallback(
    (text: string, level: "info" | "warn" | "error" = "info") =>
      update((s) => ({ ...s, items: [...s.items, { kind: "notice", text, level }] })),
    [update],
  );

  // ── A4 full-screen viewer ────────────────────────────────────────────────
  /** Stack of viewable documents (tool outputs + diffs), rebuilt from items. */
  const pagerItems = useMemo(() => pagerSources(state.items), [state.items]);
  /** `v` (input empty) — open the newest tool output / diff full-screen. */
  const openViewer = useCallback(() => {
    const items = stateRef.current.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const k = items[i].kind;
      if (k === "tool" || k === "diff") {
        setPagerAt(i);
        return;
      }
    }
    pushNotice("nothing to view yet — no tool output or diff in this session");
  }, [stateRef, pushNotice]);
  /** `y` in the pager — dump the full text to .scoder/views/ and say where. */
  const handlePagerSave = useCallback(
    (src: PagerSource) => {
      try {
        const dir = join(cfg.workdir, ".scoder", "views");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = join(dir, `${stamp}.txt`);
        writeFileSync(file, src.text.endsWith("\n") ? src.text : `${src.text}\n`);
        pushNotice(`saved → ${file}`);
      } catch (err) {
        pushNotice(`save failed: ${String(err instanceof Error ? err.message : err)}`, "error");
      }
    },
    [cfg.workdir, pushNotice],
  );

  const handleSessionSelect = useSessionResume({
    cfg, createAgent, pushNotice, update, runningRef, setScrollOffset, setSessionPickerOpen,
  });

  const tuiHost = useCommandHost({
    cfg, setCfg, update, agentRef, runningRef, eventQueue, setScrollOffset, setPermMode,
  });

  // ⇧⇥ / ⇧P — quick-switch dispatch qua registry, giống hệt gõ /agent, /permission
  // (thừa hưởng gate: ⇧⇥ chặn khi đang chạy + reset conversation; ⇧P đổi live).
  const cycleAgent = useCallback(() => {
    const next = nextInCycle(AGENT_CYCLE, tuiHost().config.agent ?? "build");
    void dispatchCommand(`/agent ${next}`, tuiHost(), pushNotice);
  }, [tuiHost, pushNotice]);
  const cyclePermission = useCallback(() => {
    const next = nextInCycle(PERMISSION_CYCLE, tuiHost().config.permissionMode);
    void dispatchCommand(`/permission ${next}`, tuiHost(), pushNotice);
  }, [tuiHost, pushNotice]);

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
    setScrollOffset, selectMode, setSelectMode, cycleAgent, cyclePermission, exit,
    paletteOpen, helpOpen, pagerOpen: pagerAt != null, openViewer,
  });

  // WARMUP (plan/WARMUP-PLAN.md): tạo agent + prefill prefix system+tools nền
  // NGAY khi mở TUI — TTFT của câu chat đầu không còn phải trả cold-load model
  // và 20–60k token prefill. Bỏ qua khi có initialTask (submit trả prefill ngay
  // sau mount, warm-up chỉ nhân đôi việc — settleWarmup sẽ abort nó).
  const warmupRef = useRef(false);
  useEffect(() => {
    if (initialTask || warmupRef.current) return;
    warmupRef.current = true;
    void createAgent().warmup();
  }, [initialTask]);

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
    const summary = state.summary?.trim();
    if (!summary) return null;
    // Chat-only runs (guardrail chat-done / text-only-streak / completion-claim
    // without files): finish summary = the assistant's FULL reply (sliced to
    // 2000). The transcript above already renders that text as markdown —
    // printing it again as a raw green "✔ …" block reads as a duplicate-output
    // bug. Dedup on display; the summary still lands in events/session log.
    const last = state.items[state.items.length - 1];
    if (last && last.kind === "assistant" && last.text.trim().startsWith(summary)) return null;
    return state.summary;
  }, [state.status, state.summary, state.items]);

      // When the run ends, jump back to the bottom so the final summary is always
  // visible — a user scrolled up would otherwise never see the conclusion.
  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    if (prevStatusRef.current === "running" && state.status !== "running") setScrollOffset(0);
    prevStatusRef.current = state.status;
  }, [state.status]);

  // P1-8: viewport mount CỬA SỔ item quanh scrollTop (transcriptWindow), không
  // mount cả transcript — chi phí layout/wrap mỗi frame hết tỷ lệ với tổng text.
  // Ink clip bằng overflow="hidden"; contentOffsetY = số dòng phải ẩn ở đầu
  // cửa sổ (scrollTop - startRow[item_start]).
  const { rows, columns } = useWindowSize();
  const showSidebar = (columns ?? 100) >= SIDEBAR_MIN_COLS;
  // Keyboard ownership: while any overlay (permission modal, session picker,
  // palette, help) is open, Input stops consuming keys — the overlay's own
  // useInput answers. (Regression this fixes: keys leaked through the
  // session picker into the input field underneath.)
  overlayRef.current = permPrompt ?? (sessionPickerOpen || paletteOpen || helpOpen || pagerAt != null ? true : null);

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
          contentOffsetY={contentOffset}
        >
        <Box ref={contentRef} flexDirection="column" paddingX={1} flexShrink={0}>
          {state.items.length === 0 ? (
            // Welcome: căn giữa cả 2 chiều — height = chiều cao đo được của
            // viewport (flexGrow không giãn được vì content box flexShrink=0).
            <Box
              flexDirection="column"
              alignItems="center"
              justifyContent="center"
              height={viewport.clientHeight || undefined}
            >
              {(columns ?? 100) - (showSidebar ? SIDEBAR_WIDTH + 2 : 4) >= 54 ? (
                <Box flexDirection="column" alignItems="center">
                  {(isAsciiMode() ? BANNER_ASCII : BANNER).map((line, i) => (
                    <Text key={i} bold color={theme.brand}>{line}</Text>
                  ))}
                </Box>
              ) : (
                <Text bold color={theme.brand}>⚑ SCoder</Text>
              )}
              <Text dimColor>{`autonomous coding agent · v${getVersion()}`}</Text>
              <Text></Text>
              <Text dimColor>type a task to start — the agent plans, edits, and builds</Text>
              <Text></Text>
              {/* Key hints: phím tắt bold nổi bật, nhãn dim — quét nhanh hơn. */}
              <Text>
                <Text bold color={theme.accent}>⏎</Text>
                <Text dimColor> send   </Text>
                <Text bold color={theme.accent}>ctrl+s</Text>
                <Text dimColor> sessions   </Text>
                <Text bold color={theme.accent}>tab</Text>
                <Text dimColor> complete   </Text>
                <Text bold color={theme.accent}>/help</Text>
                <Text dimColor> commands</Text>
              </Text>
              <Text>
                <Text bold color={theme.accent}>ctrl+o</Text>
                <Text dimColor> select/copy — releases the mouse for drag-highlight + native copy</Text>
              </Text>
                           {state.warmup?.active && (
                 <Box flexDirection="column" alignItems="center" marginTop={1}>
                   <Text dimColor>{state.warmup.message ?? "warming up…"}</Text>
                   <Box>
                     <Text color={theme.accent}>
                       {"█".repeat(Math.round((state.warmup.percent / 100) * 32))}
                       {"░".repeat(32 - Math.round((state.warmup.percent / 100) * 32))}
                     </Text>
                     <Text dimColor> {state.warmup.percent}%</Text>
                   </Box>
                 </Box>
               )}
</Box>
          ) : (
            state.items.slice(win.start, win.end).map((item, i) => (
              <ChatItemView key={win.start + i} item={item} width={(columns ?? 100) - (showSidebar ? SIDEBAR_WIDTH + 2 : 4)} />
            ))
          )}
          {lastSummary && (
            <Box marginTop={1}>
              {state.status === "success" ? (
                <Text color={theme.success} bold>
                  ✔ {lastSummary}
                </Text>
              ) : state.status === "aborted" ? (
                <Text color={theme.warn} bold>
                  ⏹ {lastSummary}
                </Text>
              ) : (
                <Text color={theme.error} bold>
                  ✘ {lastSummary}
                </Text>
              )}
            </Box>
          )}
        </Box>
        </Box>
        {thumb && (
          <Box flexDirection="column" width={1} flexShrink={0}>
            {thumb.cells.map((on, i) => (
              <Text key={i} color={on ? theme.accent : undefined} dimColor={!on}>
                {on ? charset.blockFull : "·"}
              </Text>
            ))}
          </Box>
        )}
        {/* Sidebar phải: session · MCP · metrics · phases · plan · build
            (narrow → ẩn). rows = chiều cao đo được của khung chính — sidebar
            greedy-fit theo budget, section không vừa trọn vẹn thì bỏ qua. */}
        {showSidebar && <Sidebar state={state} config={cfg} rows={viewport.clientHeight || undefined} />}
      </Box>
      {/* Session picker modal — Ctrl+S or bare "/" opens it. */}
      {sessionPickerOpen && !permPrompt && (
        <SessionPicker
          workdir={cfg.workdir}
          onSelect={handleSessionSelect}
          onClose={() => setSessionPickerOpen(false)}
        />
      )}
      {paletteOpen && !permPrompt && (
        <Palette
          agents={agentNames}
          custom={customCmds}
          onInvoke={(inv) => {
            setPaletteOpen(false);
            if (inv.kind === "action") setSessionPickerOpen(true);
            else void submit(inv.text);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {helpOpen && (
        <Box flexDirection="column" borderStyle={boxBorderStyle()} borderColor={theme.dim} paddingX={1} paddingY={1}>
          <Text color={theme.brand} bold>Help (?)</Text>
          <Text dimColor>
            keys: ⇧⏎ newline · ⇧⇥ agent build/plan/review · ⇧P permission auto/ask/readonly (empty input) · ⌃P palette
            · ⌃S sessions · ⌃T thinking · ⌃O select · v view output/diff · ? help · esc abort · ⌃C quit
          </Text>
          <Text>{formatSlashHelp("scoder tui")}</Text>
        </Box>
      )}
      {/* A4: full-screen viewer — owns the keyboard + wheel while mounted. */}
      {pagerAt != null && !permPrompt && (
        <Pager
          sources={pagerItems}
          startIndex={Math.max(0, pagerItems.findIndex((s) => s.itemId === pagerAt))}
          wheelRef={pagerWheelRef}
          onSave={handlePagerSave}
          onClose={() => setPagerAt(null)}
        />
      )}
      {/* T-03: permission modal — blocks the run until answered. */}
      {permPrompt && <PermissionModal prompt={permPrompt} />}
      {/* A5: new-content pill — only while scrolled up; tells you the run
          kept producing below the fold and how much. */}
      {newRowsPill > 0 && !pagerAt && (
        <Box paddingX={2} flexShrink={0}>
          <Text color={theme.accent}>
            {`${charset.arrowDown} +${newRowsPill} new lines · End jumps to tail`}
          </Text>
        </Box>
      )}
      <Box paddingX={1} paddingTop={0} paddingBottom={0} flexShrink={0} alignSelf="stretch">
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
          modalRef={overlayRef}
        />
      </Box>
      <StatusBar state={state} scroll={scrollOffset > 0 ? `↑ ${Math.min(scrollOffset, maxScroll)}/${maxScroll}` : null} selectMode={selectMode} />
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
    // ⇧⏎/⇧⇥ phân biệt được với Enter/Tab thường chỉ khi terminal báo modifier
    // — kitty keyboard protocol, auto mode: query CSI ?u, terminal không
    // hỗ trợ im lặng (timeout 200ms) → fallback như cũ.
    kittyKeyboard: { mode: "auto" },
  });
  await waitUntilExit();
  // Ink restores the terminal on unmount; exit explicitly so provider
  // keep-alive sockets (undici pool) can't keep the event loop alive.
  process.exit(0);
}

