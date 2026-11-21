/** Global keybinds: permission modal answers, scroll/abort, Ctrl+C confirm-quit. */
import { useInput } from "ink";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Agent, AgentEvent } from "../../agent.js";
import { logNote, markAborted, type TuiState } from "../state.js";

export function useTuiKeybinds(deps: {
  scrollOffset: number;
  permPromptRef: { current: Extract<AgentEvent, { type: "permission_request" }> | null };
  setPermPrompt: Dispatch<SetStateAction<Extract<AgentEvent, { type: "permission_request" }> | null>>;
  agentRef: { current: Agent | null };
  runningRef: { current: boolean };
  sessionPickerOpen: boolean;
  setSessionPickerOpen: Dispatch<SetStateAction<boolean>>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  inputRef: { current: string };
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  update: (fn: (s: TuiState) => TuiState) => void;
  viewportRowsRef: { current: number | null };
  setScrollOffset: Dispatch<SetStateAction<number>>;
  /** Ctrl+O — release mouse tracking so the terminal's native drag-select/copy works. */
  selectMode: boolean;
  setSelectMode: Dispatch<SetStateAction<boolean>>;
  /** ⇧⇥ — cycle primary agent build→plan→review (dispatch /agent, cùng gate idle). */
  cycleAgent: () => void;
  /** ⇧P (khi input trống) — cycle permission auto→ask→readonly (dispatch /permission). */
  cyclePermission: () => void;
  /** P2: palette/help overlay open — overlay owns the keyboard while shown. */
  paletteOpen: boolean;
  helpOpen: boolean;
  /** A4: full-screen viewer open — it owns keys + wheel entirely. */
  pagerOpen: boolean;
  /** `v` (input empty) — open the newest tool output / diff in the viewer. */
  openViewer: () => void;
  /** P8: sidebar tab + harness-log keyboard routing (see app.tsx logHandlers). */
  sidebarTab: "overview" | "log";
  logHandlers: {
    toggleTab: () => void;
    move: (d: number) => void;
    scroll: (d: number) => void;
    top: () => void;
    tail: () => void;
    cycleFilter: () => void;
    toggleDetail: () => void;
    openEntry: () => void;
    copyEntry: () => void;
    escChain: () => "handled";
  };
  exit: () => void;
}) {
  const { scrollOffset, permPromptRef, setPermPrompt, agentRef, runningRef, sessionPickerOpen, setSessionPickerOpen, setPaletteOpen, inputRef, setHelpOpen, update, viewportRowsRef, setScrollOffset, selectMode, setSelectMode, cycleAgent, cyclePermission, paletteOpen, helpOpen, pagerOpen, openViewer, sidebarTab, logHandlers, exit } = deps;
  // Esc aborts the running task (like SIGINT in the CLI); when scrolled up,
  // the first Esc returns to the bottom instead.
  const scrollOffsetRef = useRef(0);
  useEffect(() => {
    scrollOffsetRef.current = scrollOffset;
  }, [scrollOffset]);
  // useInput closures go stale between renders (same reason as scrollOffsetRef).
  const selectModeRef = useRef(false);
  useEffect(() => {
    selectModeRef.current = selectMode;
  }, [selectMode]);
  // T-03: permission modal keybinds — intercepts y/a/n/q while open.
  useInput((input, key) => {
    const p = permPromptRef.current;
    if (!p) return;
    const answer = key.return ? "yes" : input.toLowerCase() === "y" ? "yes" : input.toLowerCase() === "a" ? "always" : input.toLowerCase() === "n" ? "no" : input.toLowerCase() === "q" ? "quit" : key.escape ? "no" : null;
    if (!answer) return;
    setPermPrompt(null);
    // P8: the answer lives in the UI, not the event stream — record it in the
    // harness log so the log shows ask → answer pairs.
    update((s) => logNote(s, "perm", `answer ${answer}: ${p.command ?? p.label}`));
    agentRef.current?.resolvePermission(p.id, answer);
  });

  // T-01/T-02: scroll + abort keybinds.
  useInput((_input, key) => {
    if (permPromptRef.current) return; // modal owns the keyboard

    // ── Ctrl+P: command palette (open AND close — the palette itself only
    // binds esc, so ctrl+p never double-toggles) ──
    if (key.ctrl && _input === "p") {
      setPaletteOpen((o) => !o);
      return;
    }
    // ── Help overlay: open/close keys are handled here; everything else is
    // blocked while it is on screen (it replaced the old always-toggle '?'). ──
    if (helpOpen) {
      if (_input === "?" || key.escape) setHelpOpen(false);
      return;
    }
    // ── Session picker / palette / viewer open: the overlay's own useInput
    // answers. Global keys (cycle, scroll, abort, ?) must NOT leak through. ──
    if (paletteOpen || sessionPickerOpen || pagerOpen) return;

    // ── Ctrl+B: toggle sidebar tab OVERVIEW ⇄ HARNESS LOG ──
    if (key.ctrl && _input === "b") {
      logHandlers.toggleTab();
      return;
    }
    // ── P8: log-tab keys — active only while the LOG tab is shown AND the
    // input is empty (same convention as ⇧P / ?); typing returns focus. ──
    if (sidebarTab === "log" && !inputRef.current.trim()) {
      if (key.upArrow) return logHandlers.move(-1);
      if (key.downArrow) return logHandlers.move(1);
      if (_input === "k") return logHandlers.move(-1);
      if (_input === "j") return logHandlers.move(1);
      if (key.pageUp) return logHandlers.scroll(10);
      if (key.pageDown) return logHandlers.scroll(-10);
      if (key.home || _input === "g") return logHandlers.top();
      if (key.end || _input === "G") return logHandlers.tail();
      if (_input === "f") return logHandlers.cycleFilter();
      if (_input === "d") return logHandlers.toggleDetail();
      if (key.return) return logHandlers.openEntry();
      if (_input === "y") return logHandlers.copyEntry();
      if (key.escape) return logHandlers.escChain();
      // Anything else (⌃S/⌃T/⌃O/?/v/typing…) falls THROUGH to the global
      // handlers below — the log keys must not swallow the rest of the app.
    }

    // ── v (input empty): full-screen viewer for the newest output/diff ──
    if (_input === "v" && !inputRef.current.trim()) {
      openViewer();
      return;
    }

    // ── Ctrl+S: open session picker (when not running) ──
    if (key.ctrl && _input === "s") {
      if (!runningRef.current) {
        setSessionPickerOpen(true);
      }
      return;
    }
    // ── ⇧⇥ (ESC [ Z hoặc kitty): cycle agent build→plan→review. Dispatch qua
    // registry nên thừa hưởng gate của /agent: đang chạy thì chặn, switch =
    // reset conversation. ──
    if (key.tab && key.shift) {
      cycleAgent();
      return;
    }
    // ── ⇧P: cycle permission auto→ask→readonly. Chỉ khi input trống —
    // cùng quy ước với "?" (help) — để vẫn gõ được chữ "P" hoa giữa câu. ──
    if (key.shift && _input === "P" && !inputRef.current) {
      cyclePermission();
      return;
    }
    // ── ?: help overlay (when input empty) ──
    if (_input === "?" && !inputRef.current.trim()) {
      setHelpOpen((o) => !o);
      return;
    }

    // T-10: ctrl+t toggles the thinking stream visibility.
    if (key.ctrl && _input === "t") {
      update((s) => ({ ...s, thinkingVisible: !s.thinkingVisible }));
      return;
    }
    // Ctrl+O: toggle select mode — mouse tracking off (native drag-select +
    // Cmd/Ctrl+C copy) / on (wheel scroll). Scroll with PgUp/PgDn while off.
    if (key.ctrl && _input === "o") {
      const next = !selectModeRef.current;
      selectModeRef.current = next;
      setSelectMode(next);
      update((s) => ({
        ...s,
        items: [...s.items, {
          kind: "notice",
          text: next
            ? "select mode ON — drag to highlight, copy with ⌘C/Ctrl+C · scroll via PgUp/PgDn · Ctrl+O back to mouse wheel"
            : "select mode OFF — mouse wheel scrolling restored",
          level: "info",
        }],
      }));
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
}
