/**
 * `/shortcut` — every keybinding of the TUI in one place, shown in the
 * full-screen viewer. Static cheat sheet mirroring the real handlers
 * (use-keybinds.ts, input.tsx, pager.tsx, sidebar log tab, palette,
 * session-picker); keep it in sync when bindings change. Pure + unit-tested.
 *
 * Key notation is SPELLS OUT modifiers (Ctrl+P, Shift+Tab, Enter, Up/Down) —
 * no ⌃ ⇧ ⏎ ⇥ glyphs: they read as icons and are impossible to scan quickly.
 */

export interface ShortcutRow {
  /** Key combo column, e.g. "Ctrl+P" or "Shift+Tab". */
  keys: string;
  /** What it does. */
  what: string;
}

export interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

export function shortcutSections(): ShortcutSection[] {
  return [
    {
      title: "GLOBAL",
      rows: [
        { keys: "Enter", what: "send the task / run a slash command" },
        { keys: "Shift+Enter", what: "newline in the input (Alt+Enter or Ctrl+J also work)" },
        { keys: "Shift+Tab", what: "cycle agent build > plan > review (idle, input empty)" },
        { keys: "Shift+P", what: "cycle permission auto > ask > readonly (input empty)" },
        { keys: "Ctrl+P", what: "command palette — fuzzy search actions, commands, agents" },
        { keys: "Ctrl+S", what: "session picker (idle)" },
        { keys: "Ctrl+T", what: "toggle the thinking stream" },
        { keys: "Ctrl+O", what: "select mode — releases the mouse for native drag-highlight + copy" },
        { keys: "Ctrl+B", what: "sidebar tab: OVERVIEW → ROUTER → HARNESS LOG" },
        { keys: "?", what: "help overlay (input empty)" },
        { keys: "v", what: "open the newest tool output / diff in the viewer (input empty)" },
        { keys: "Esc", what: "jump back to the live tail · press again to abort the run" },
        { keys: "Ctrl+C", what: "quit (press twice within 2 s while a run is active)" },
        { keys: "mouse wheel", what: "scroll the transcript (or the open viewer)" },
      ],
    },
    {
      title: "SCROLLING THE TRANSCRIPT",
      rows: [
        { keys: "PageUp / PageDown", what: "page up / down (0.8 viewport)" },
        { keys: "Home / End", what: "jump to the top / back to the bottom" },
      ],
    },
    {
      title: "INPUT EDITING",
      rows: [
        { keys: "Up / Down", what: "recall previous messages" },
        { keys: "Tab", what: "complete slash commands + /skill /mcp arguments" },
        { keys: "@", what: "fuzzy file autocomplete" },
        { keys: "Esc", what: "vim normal mode — h l w b e 0 $ x i a A · Enter back to insert" },
      ],
    },
    {
      title: "HARNESS LOG TAB  (Ctrl+B · input empty)",
      rows: [
        { keys: "Up / Down or j k", what: "select a row" },
        { keys: "PageUp / PageDown", what: "scroll the list" },
        { keys: "g / G", what: "first / last row" },
        { keys: "f", what: "cycle filter ALL · LLM · TOOL · MCP · SUB · EVT" },
        { keys: "F", what: "dump the filtered log into the viewer" },
        { keys: "d", what: "toggle the detail pane" },
        { keys: "Enter", what: "open the full payload in the viewer" },
        { keys: "y", what: "copy the entry (OSC 52)" },
        { keys: "Esc", what: "close the detail pane · press again to leave the log tab" },
      ],
    },
    {
      title: "FULL-SCREEN VIEWER  (opened by v · Enter · F)",
      rows: [
        { keys: "Up / Down or j k", what: "scroll one line" },
        { keys: "PageUp / PageDown", what: "page up / down" },
        { keys: "g / G · Home / End", what: "top / bottom" },
        { keys: "Tab / Shift+Tab", what: "next / previous document" },
        { keys: "w", what: "toggle word-level diff highlighting (diffs)" },
        { keys: "y", what: "save the full text to .scoder/views/" },
        { keys: "q / Esc", what: "close the viewer" },
      ],
    },
    {
      title: "PALETTE  (Ctrl+P)",
      rows: [
        { keys: "type", what: "fuzzy filter" },
        { keys: "Up / Down or j k", what: "move the selection" },
        { keys: "Enter", what: "run the highlighted action" },
        { keys: "Esc", what: "close" },
      ],
    },
    {
      title: "SESSION PICKER  (Ctrl+S)",
      rows: [
        { keys: "Up / Down or j k", what: "move the selection" },
        { keys: "Enter", what: "resume the highlighted session" },
        { keys: "Esc", what: "close" },
      ],
    },
  ];
}

/** Render the cheat sheet as viewer text: section titles + aligned rows. */
export function formatShortcuts(width = 76): string {
  const out: string[] = [];
  for (const sec of shortcutSections()) {
    out.push(`── ${sec.title} ${"─".repeat(Math.max(0, width - sec.title.length - 4))}`);
    const pad = Math.min(20, Math.max(...sec.rows.map((r) => r.keys.length)) + 2);
    for (const r of sec.rows) out.push(`  ${r.keys.padEnd(pad)}${r.what}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}
