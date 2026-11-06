/** Global keybinds: permission modal answers, scroll/abort, Ctrl+C confirm-quit. */
import { useInput } from "ink";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Agent, AgentEvent } from "../../agent.js";
import { markAborted, type TuiState } from "../state.js";

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
  exit: () => void;
}) {
  const { scrollOffset, permPromptRef, setPermPrompt, agentRef, runningRef, sessionPickerOpen, setSessionPickerOpen, setPaletteOpen, inputRef, setHelpOpen, update, viewportRowsRef, setScrollOffset, exit } = deps;
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

    // ── Ctrl+S: open session picker (when not running, not already open) ──
    if (key.ctrl && _input === "s") {
      if (!runningRef.current && !sessionPickerOpen) {
        setSessionPickerOpen(true);
      }
      return;
    }
    // ── Ctrl+P: command palette ──
    if (key.ctrl && _input === "p") {
      setPaletteOpen((o) => !o);
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
