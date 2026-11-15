/**
 * Drawing charset — every box-drawing / block / marker glyph the TUI paints,
 * in one place, with an ASCII-only fallback for terminals without Unicode
 * (TERM=dumb, legacy Windows consoles, some CI logs).
 *
 * ASCII mode activates when SCODER_ASCII=1 or TERM=dumb. Colors are NOT
 * handled here: Ink/chalk already respect NO_COLOR and FORCE_COLOR.
 */

export interface Charset {
  // Box drawing
  tl: string; tr: string; bl: string; br: string;
  h: string; v: string;
  teeDown: string; teeUp: string; teeRight: string; teeLeft: string; cross: string;
  // Chart blocks
  blockFull: string; blockEmpty: string; barMarker: string;
  // List / status markers
  bullet: string; taskDone: string; taskTodo: string;
  ok: string; fail: string; active: string; pending: string;
  // Code wrap continuation
  cont: string;
  // Spinner frames
  spinner: string[];
  // ── Graph drawing (flowchart renderer, P9) ────────────────────────────────
  /** 16 line glyphs indexed by connection mask: bit 1=up 2=right 4=down 8=left. */
  line: string[];
  /** Thick / dotted edge glyphs: [horizontal, vertical]. */
  hHeavy: string; vHeavy: string; hDotted: string; vDotted: string;
  /** Edge-head arrows, one per absolute direction. */
  arrowUp: string; arrowRight: string; arrowDown: string; arrowLeft: string;
  /** Node border corner sets, ordered [topLeft, topRight, bottomRight, bottomLeft]. */
  cornerRect: string[]; cornerRound: string[]; cornerDiamond: string[];
  /** Back-edge / wrap marker. */
  loop: string;
}

// Connection-mask glyph table: index = up(1) | right(2) | down(4) | left(8).
// A cell shows the arms it has: up+right=╰ · up+left=╯ · down+right=┌ ·
// down+left=┐ · no-left=├ · no-right=┤ · no-down=┴ · no-up=┬ — so elbow
// routing needs no corner special-casing.
const LINE_UNICODE = [
  " ", "│", "─", "╰", "│", "│", "┌", "├",
  "─", "╯", "─", "┴", "┐", "┤", "┬", "┼",
];
const LINE_ASCII = [
  " ", "|", "-", "+", "|", "|", "+", "+",
  "-", "+", "-", "+", "+", "+", "+", "+",
];

const UNICODE: Charset = {
  tl: "┌", tr: "┐", bl: "└", br: "┘",
  h: "─", v: "│",
  teeDown: "┬", teeUp: "┴", teeRight: "├", teeLeft: "┤", cross: "┼",
  blockFull: "█", blockEmpty: "░", barMarker: "▌",
  bullet: "•", taskDone: "☑", taskTodo: "☐",
  ok: "✓", fail: "✗", active: "◆", pending: "○",
  cont: "↪",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  line: LINE_UNICODE,
  hHeavy: "═", vHeavy: "║", hDotted: "╌", vDotted: "┆",
  arrowUp: "▲", arrowRight: "▶", arrowDown: "▼", arrowLeft: "◀",
  cornerRect: ["┌", "┐", "┘", "└"],
  cornerRound: ["╭", "╮", "╯", "╰"],
  cornerDiamond: ["╱", "╲", "╱", "╲"],
  loop: "↩",
};

const ASCII: Charset = {
  tl: "+", tr: "+", bl: "+", br: "+",
  h: "-", v: "|",
  teeDown: "+", teeUp: "+", teeRight: "+", teeLeft: "+", cross: "+",
  blockFull: "#", blockEmpty: ".", barMarker: "|",
  bullet: "*", taskDone: "[x]", taskTodo: "[ ]",
  ok: "v", fail: "x", active: ">", pending: "o",
  cont: ">",
  spinner: ["-", "\\", "|", "/"],
  line: LINE_ASCII,
  hHeavy: "=", vHeavy: "|", hDotted: ".", vDotted: ":",
  arrowUp: "^", arrowRight: ">", arrowDown: "v", arrowLeft: "<",
  cornerRect: ["+", "+", "+", "+"],
  cornerRound: ["+", "+", "+", "+"],
  cornerDiamond: ["/", "\\", "/", "\\"],
  loop: "<-",
};

export function isAsciiMode(): boolean {
  return process.env.SCODER_ASCII === "1" || process.env.TERM === "dumb";
}

/** Active charset — resolved once at module load (env is static per process). */
export const charset: Charset = isAsciiMode() ? ASCII : UNICODE;

/** Ink borderStyle for code/diff boxes: "classic" is the ASCII-safe style. */
export function boxBorderStyle(): "round" | "classic" {
  return isAsciiMode() ? "classic" : "round";
}

/** Ink borderStyle for one-sided divider rules (app bars): thin, ASCII-safe. */
export function dividerBorderStyle(): "single" | "classic" {
  return isAsciiMode() ? "classic" : "single";
}
