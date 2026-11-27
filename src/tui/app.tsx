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
import { Box, Text, useApp, useStdin, useWindowSize } from "ink";
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
import { DiagramFocusContext } from "./markdown/diagram.js"; // P2.3 live focus
import { BuildRail, HelpLine, StatusBar, SIDEBAR_MIN_COLS, SIDEBAR_WIDTH, osc52Copy } from "./chrome.js"; // T2
import { clipCells } from "./text-width.js";
import { Input } from "./input.js"; // T2
import { SessionPicker } from "./session-picker.js"; // session picker modal
import { Palette } from "./palette.js"; // command palette (Ctrl+P)
import { Pager, pagerSources, type PagerSource } from "./pager.js"; // full-screen viewer (A4)
import {
  DEFAULT_LOG_VIEW,
  LOG_FILTER_CYCLE,
  detailMeta,
  filterLog,
  fmtLogTs,
  followOffset,
  logDetailLines,
  renderLog,
  moveSelection,
  resolveLogPayload,
  type LogFilter,
  type LogView,
} from "./log.js"; // harness log (P8)
import { fileIndex } from "./at-complete.js";
import { newContentPill, scrollThumb, tailAnchor } from "./scrollbar.js"; // A5 scroll affordances
import { formatShortcuts } from "./shortcuts.js"; // /shortcut cheat sheet
import { getTheme, setActiveTheme, theme } from "./theme.js";
import { boxBorderStyle, charset, isAsciiMode } from "./charset.js";
import { PermissionModal } from "./permission-modal.js"; // T2
import { nextSidebarTab, Sidebar, type SidebarTab } from "./sidebar.js"; // sidebar opencode
import { getVersion } from "../shared/version.js";
import { useScrollMetrics } from "./hooks/use-scroll.js";
import { useGitStatus } from "./hooks/use-git-status.js";

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
import { FOCUS_ENABLE, FOCUS_DISABLE, parseFocus } from "./mouse.js";
import { buildNotify, emitNotify, notifyBody, shouldNotify } from "./notify.js";
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
  // P8: sidebar tab + harness-log view (UI prefs — deliberately NOT in
  // TuiState, which is the transcript/reducer model).
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("overview");
  const [logView, setLogView] = useState<LogView>(DEFAULT_LOG_VIEW);
  // P8: viewer opened from the log (entry payload) instead of a transcript item.
  // `/shortcut` reuses the same slot with its own title (shortcuts.ts).
  const [pagerLog, setPagerLog] = useState<{ entryId: number; text: string; title?: string } | null>(null);
  // P6: desktop notify on finish. `focused` starts true — terminals without
  // DEC 1004 never report, and the >45s fallback covers long runs there.
  const { stdin: focusStdin, isRawModeSupported: focusSupported } = useStdin();
  const focusedRef = useRef(true);
  const sawFocusRef = useRef(false);
  useEffect(() => {
    if (process.stdout.isTTY !== true || !focusSupported || cfg.notify === false) return;
    process.stdout.write(FOCUS_ENABLE);
    const onData = (chunk: Buffer | string) => {
      const f = parseFocus(String(chunk));
      if (!f) return;
      sawFocusRef.current = true;
      focusedRef.current = f === "in";
    };
    focusStdin.on("data", onData);
    return () => {
      focusStdin.off("data", onData);
      process.stdout.write(FOCUS_DISABLE);
    };
  }, [cfg.notify, focusStdin, focusSupported]);
  // Fire when the reducer moves running → success/failed (abort excluded).
  const notifyPrevStatusRef = useRef<TuiState["status"]>("idle");
  useEffect(() => {
    const prev = notifyPrevStatusRef.current;
    notifyPrevStatusRef.current = state.status;
    if (prev !== "running") return;
    if (state.status !== "success" && state.status !== "failed") return;
    const durMs = state.startedAt != null ? (state.endedAt ?? Date.now()) - state.startedAt : 0;
    if (!shouldNotify({ enabled: cfg.notify !== false, focused: focusedRef.current, sawFocusEvents: sawFocusRef.current, durationMs: durMs })) return;
    emitNotify(buildNotify("SCoder", notifyBody(state.status, state.summary ?? "", state.step, durMs)));
  }, [state.status, state.summary, state.step, state.startedAt, state.endedAt, cfg.notify]);
  const inputRef = useRef(initialTask ?? "");
  // ── Reserved single-key shortcuts (P8 fix) ── Ink calls EVERY useInput
  // handler for a keystroke, so a shortcut char (?, log keys) would also
  // land in the input unless Input itself swallows it. The set mirrors the
  // gating in use-keybinds: global chars always, log chars only on the LOG
  // tab — both only meaningful while the line is empty (checked in Input).
  // `v` left this set when the viewer moved behind /view — so "v" types freely
  // as the first character of a message again.
  const reservedKeysRef = useRef<Set<string>>(new Set(["?"]));
  useEffect(() => {
    reservedKeysRef.current =
      sidebarTab === "log" ? new Set(["?", "j", "k", "f", "d", "y", "g", "G", "F"]) : new Set(["?"]);
  }, [sidebarTab]);
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
  // ── Tail anchor (scrollbar.ts) ── estimate over-counts rows on wide
  // terminals ⇒ estimated bottom sits past the real one: scrolling back down
  // left the last generated line floating mid-screen with blank below and
  // pill/thumb still reporting "scrolled up". Clamp contentOffset to the
  // mounted window's measured bottom and treat as at-bottom for every
  // offset-derived affordance.
  const anchor = tailAnchor({
    track: viewport.clientHeight,
    totalRows: win.totalRows,
    maxScroll,
    offset: scrollOffset,
    winOffset: win.offset,
    contentHeight: content.height,
    hasMeasured: content.hasMeasured,
    tailMounted: win.end >= state.items.length,
  });
  const effScrollOffset = anchor.offset;
  // A5 pill: baseline = row count captured the moment the user scrolled up;
  // growth after that is "new content behind you". Cleared at the bottom.
  const scrollBaseRowsRef = useRef<number | null>(null);
  if (effScrollOffset === 0) scrollBaseRowsRef.current = null;
  else if (scrollBaseRowsRef.current == null) scrollBaseRowsRef.current = win.totalRows;
  const newRowsPill = newContentPill(scrollBaseRowsRef.current ?? win.totalRows, win.totalRows, effScrollOffset);
  // A5 thumb: a 1-column proportional scrollbar on the chat pane's right
  // edge; off in select mode (the rail would be copied as text).
  const thumb = selectMode ? null : scrollThumb(viewport.clientHeight || 0, anchor.totalRows, effScrollOffset);
  // Follow-bottom (scrollOffset = 0) OR tail-pinned: exact measured offset.
  const contentOffset = anchor.contentOffset;

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
  // P7: branch + dirty count for the BuildRail — async probe, never blocks.
  const gitStatus = useGitStatus(cfg.workdir ?? process.cwd(), state.status === "running");
  const pushNotice = useCallback(
    (text: string, level: "info" | "warn" | "error" = "info") =>
      update((s) => ({ ...s, items: [...s.items, { kind: "notice", text, level }] })),
    [update],
  );

  // ── A4 full-screen viewer ────────────────────────────────────────────────
  /** Stack of viewable documents (tool outputs + diffs), rebuilt from items. */
  const pagerItems = useMemo(() => pagerSources(state.items), [state.items]);
  /** `/view` — open the newest tool output / diff full-screen (was `v`, input empty). */
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

  // ── P8: harness log handlers (sidebar tab + `/log`) ───────────────────────
  /** View mirror for handlers wired once per session — read at key time. */
  const logViewRef = useRef(logView);
  logViewRef.current = logView;
  /** Full payload for the viewer entry-point (item → jsonl fallback). */
  const logPayload = useCallback(
    (entry: (typeof stateRef.current.log)[number]) =>
      resolveLogPayload(entry, stateRef.current.items, {
        workdir: cfg.workdir,
        sessionId: agentRef.current?.sessionId ?? "",
      }),
    [cfg.workdir],
  );
  /** ⏎ on a selected log row → open the viewer with its full payload. */
  const openLogEntry = useCallback(() => {
    const s = stateRef.current;
    const entry = s.log.find((e) => e.id === logViewRef.current.selId);
    if (!entry) {
      pushNotice("no log row selected — ↑/↓ first");
      return;
    }
    const p = logPayload(entry);
    if (!p) {
      pushNotice("payload not available (evicted and not in the session log)");
      return;
    }
    setPagerLog({ entryId: entry.id, text: `${p.text}${detailMeta(entry)}` });
  }, [logPayload, pushNotice]);
  /** `y` — copy the selected entry (JSON) to the clipboard via OSC 52. */
  const copyLogEntry = useCallback(() => {
    const s = stateRef.current;
    const entry = s.log.find((e) => e.id === logViewRef.current.selId);
    if (!entry) {
      pushNotice("no log row selected — ↑/↓ first");
      return;
    }
    const json = JSON.stringify({ ...entry, payload: logPayload(entry)?.text ?? null }, null, 1);
    if (osc52Copy(json)) pushNotice(`copied log entry #${entry.id} (OSC 52)`);
    else handlePagerSave({ title: `log ${entry.id}`, kind: "output", text: json, meta: entry.cat, itemId: -1 });
  }, [logPayload, pushNotice, handlePagerSave]);
  /** `/log [cat]` — render the (filtered) harness log into the full-screen viewer. */
  const openLogPager = useCallback(
    (arg: string) => {
      const s = stateRef.current;
      const f = arg.toUpperCase();
      // Bucket names (TOOL, EVT…) AND raw categories (shell, build, guard…)
      // both work — the dump is for grepping, finer is better.
      const CATS = ["run", "llm", "tool", "shell", "file", "build", "mcp", "sub", "guard", "perm", "evt"] as const;
      const asCat = f.toLowerCase() as (typeof CATS)[number];
      let entries: typeof s.log;
      if (f === "" || f === "ALL") entries = s.log;
      else if ((["ALL", "LLM", "TOOL", "MCP", "SUB", "EVT"] as const).includes(f as never)) entries = filterLog(s.log, f as LogFilter);
      else if (CATS.includes(asCat)) entries = s.log.filter((e) => e.cat === asCat);
      else {
        pushNotice(`unknown category "${arg}" — ALL|LLM|TOOL|MCP|SUB|EVT or a single cat (shell, build, guard…)`);
        return;
      }
      if (entries.length === 0) {
        pushNotice("harness log is empty — events land here as the agent works");
        return;
      }
      // Wide lines (no clipping): the sidebar truncates, the viewer doesn't.
      const text = entries
        .map((e) => `${fmtLogTs(e.ts)} ${renderLog(e, 240)}${detailMeta(e).replace("\n", "   ")}`)
        .join("\n");
      setPagerLog({ entryId: -1, text: `# HARNESS LOG · ${f || "ALL"} · ${entries.length} entries\n${text}` });
    },
    [pushNotice],
  );

  /** `/shortcut` — the keybinding cheat sheet in the full-screen viewer. */
  const openShortcutsPager = useCallback(() => {
    setPagerLog({ entryId: -1, title: "keybindings · /shortcut", text: formatShortcuts() });
  }, []);

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
    historyRef, setScrollOffset, createAgent, bumpFrame, openLogPager, openShortcutsPager, openViewer,
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

  // P8: keyboard routing for the harness-log tab. The view lives in app state;
  // these callbacks are stable (they read logViewRef/stateRef at key time).
  // Mirror of Sidebar's LogTab budget so the window follows the cursor.
  const logListRows = useCallback(() => {
    const total = viewportRowsRef.current ?? 24;
    const avail = Math.max(8, total - 3);
    const v = logViewRef.current;
    const sel = v.detail && v.selId != null ? stateRef.current.log.find((e) => e.id === v.selId) : undefined;
    const detailRows = sel ? logDetailLines(sel, SIDEBAR_WIDTH - 4, clipCells).length + 2 : 0;
    return Math.max(1, avail - 2 - detailRows);
  }, [viewportRowsRef, stateRef]);
  const logHandlers = useMemo(() => ({
    toggleTab: () => setSidebarTab(nextSidebarTab),
    move: (d: number) => {
      const s = stateRef.current;
      setLogView((v) => {
        const visible = filterLog(s.log, v.filter);
        const selId = moveSelection(visible.map((e) => e.id), v.selId, d);
        return { ...v, selId, offset: followOffset(visible, logListRows(), v.offset, selId) };
      });
    },
    scroll: (d: number) => setLogView((v) => ({ ...v, offset: Math.max(0, v.offset + d), selId: null })),
    top: () => setLogView((v) => ({ ...v, offset: 999_999, selId: null })),
    tail: () => setLogView((v) => ({ ...v, offset: 0, selId: null })),
    cycleFilter: () => setLogView((v) => {
      const i = LOG_FILTER_CYCLE.indexOf(v.filter);
      return { ...v, filter: LOG_FILTER_CYCLE[(i + 1) % LOG_FILTER_CYCLE.length], selId: null, offset: 0 };
    }),
    toggleDetail: () => setLogView((v) => ({ ...v, detail: !v.detail })),
    openEntry: openLogEntry,
    copyEntry: copyLogEntry,
    // `F` — same dump as `/log`, using the CURRENT filter (wide viewer rows).
    dump: () => openLogPager(logViewRef.current.filter),
    escChain: () => {
      const v = logViewRef.current;
      if (v.detail) { setLogView({ ...v, detail: false }); return "handled" as const; }
      if (v.selId != null) { setLogView({ ...v, selId: null }); return "handled" as const; }
      if (v.offset > 0) { setLogView({ ...v, offset: 0 }); return "handled" as const; }
      setSidebarTab("overview");
      return "handled" as const;
    },
  }), [stateRef, openLogEntry, copyLogEntry, openLogPager]);

  useTuiKeybinds({
    scrollOffset, permPromptRef, setPermPrompt, agentRef, runningRef, sessionPickerOpen,
    setSessionPickerOpen, setPaletteOpen, inputRef, setHelpOpen, update, viewportRowsRef,
    setScrollOffset, selectMode, setSelectMode, cycleAgent, cyclePermission, exit,
    paletteOpen, helpOpen, pagerOpen: pagerAt != null || pagerLog != null,
    sidebarTab, logHandlers,
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
  overlayRef.current = permPrompt ?? (sessionPickerOpen || paletteOpen || helpOpen || pagerAt != null || pagerLog != null ? true : null);

  return (
    // flexShrink={0}: pinned chrome must never be squeezed when the chat
    // content overflows — Ink defaults every box to flexShrink:1, which
    // shrank the input bar to zero rows once the log outgrew the terminal.
    // P2.3: diagram_focus events reach memoized markdown blocks through this
    // context (ChatItemView props stay stable; context skips the memo wall).
    <DiagramFocusContext.Provider value={state.diagramFocus}>
    <Box flexDirection="column" height={rows || 24} flexShrink={0}>
      <BuildRail state={state} config={cfg} git={gitStatus} />
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
              {/* Key hints: spelled-out modifiers (Ctrl+S, Shift+Enter) — ⌃ ⇧ ⏎
                  read as icons. Phím tắt bold, nhãn dim — quét nhanh hơn. */}
              <Text>
                <Text bold color={theme.accent}>Enter</Text>
                <Text dimColor> send   </Text>
                <Text bold color={theme.accent}>Ctrl+S</Text>
                <Text dimColor> sessions   </Text>
                <Text bold color={theme.accent}>Tab</Text>
                <Text dimColor> complete   </Text>
                <Text bold color={theme.accent}>/help</Text>
                <Text dimColor> commands</Text>
              </Text>
              <Text>
                <Text bold color={theme.accent}>Ctrl+O</Text>
                <Text dimColor> select/copy — releases the mouse for drag-highlight + native copy</Text>
              </Text>
              <Text>
                <Text bold color={theme.accent}>/shortcut</Text>
                <Text dimColor> or </Text>
                <Text bold color={theme.accent}>?</Text>
                <Text dimColor>  — every keybinding in this app</Text>
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
      {thumb !== null && (
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
        {showSidebar && (
          <Sidebar
            state={state}
            config={cfg}
            rows={viewport.clientHeight || undefined}
            tab={sidebarTab}
            view={logView}
          />
        )}
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
        // maxHeight + overflow: the frame has to stay inside the terminal. A Box
        // taller than the screen makes Ink's diff paint torn rows (the command
        // list alone is 23 lines) — keys stay on top, the list clips instead.
        <Box
          flexDirection="column"
          borderStyle={boxBorderStyle()}
          borderColor={theme.dim}
          paddingX={1}
          paddingY={1}
          overflow="hidden"
          maxHeight={Math.max(10, (rows ?? 24) - 8)}
        >
          <Text color={theme.brand} bold>Help — press ? or Esc to close</Text>
          <Text dimColor>Single-letter keys act when the input line is empty. Every binding: /shortcut · every command: /help</Text>
          <HelpLine
            items={[
              ["Enter", "send"],
              ["Shift+Enter", "newline"],
              ["Tab", "complete"],
              ["Up/Down", "history"],
              ["Esc", "abort"],
              ["Ctrl+C", "quit"],
            ]}
          />
          <HelpLine
            items={[
              ["Ctrl+P", "palette"],
              ["Ctrl+S", "sessions"],
              ["Ctrl+T", "thinking"],
              ["Ctrl+O", "select/copy"],
              ["Ctrl+B", "sidebar tab (3-way)"],
            ]}
          />
          <HelpLine
            items={[
              ["/view", "output/diff fullscreen"],
              ["Shift+Tab", "agent build/plan/review"],
              ["Shift+P", "permission auto/ask/readonly"],
            ]}
          />
          <HelpLine
            items={[
              ["Ctrl+B", "log tab keys:"],
              ["Up/Down", "select"],
              ["g / G", "first / last"],
              ["f", "filter"],
              ["d", "detail"],
              ["Enter", "payload"],
              ["F", "dump"],
              ["y", "copy"],
              ["/log [cat]", "in the viewer"],
            ]}
          />
          <Text>{formatSlashHelp("scoder tui")}</Text>
        </Box>
      )}
      {/* A4: full-screen viewer — owns the keyboard + wheel while mounted. */}
      {pagerAt != null && !permPrompt && !pagerLog && (
        <Pager
          sources={pagerItems}
          startIndex={Math.max(0, pagerItems.findIndex((s) => s.itemId === pagerAt))}
          wheelRef={pagerWheelRef}
          onSave={handlePagerSave}
          onClose={() => setPagerAt(null)}
        />
      )}
      {/* P8: viewer opened from a harness-log row (full payload) — or /shortcut. */}
      {pagerLog && !permPrompt && (
        <Pager
          sources={[{
            title: pagerLog.title ?? `harness log entry ${pagerLog.entryId >= 0 ? `#${pagerLog.entryId}` : "(filtered dump)"}`,
            kind: "output",
            text: pagerLog.text,
            meta: "from state.log",
            itemId: -1,
          }]}
          startIndex={0}
          wheelRef={pagerWheelRef}
          onSave={handlePagerSave}
          onClose={() => setPagerLog(null)}
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
          maxRows={Math.max(2, Math.min(8, Math.floor((rows || 24) / 3)))}
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
          reservedRef={reservedKeysRef}
        />
      </Box>
      <StatusBar state={state} scroll={effScrollOffset > 0 ? `${Math.min(effScrollOffset, maxScroll)}/${maxScroll} above` : null} selectMode={selectMode} sidebarTab={sidebarTab} git={gitStatus} />
    </Box>
    </DiagramFocusContext.Provider>
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

