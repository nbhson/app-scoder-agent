/**
 * Display-width helpers — SINGLE source of truth for measuring, clipping,
 * padding and wrapping visible text in the TUI.
 *
 * Rules:
 * - Width is measured in terminal cells (via string-width): emoji and CJK are
 *   2 cells, combining marks (e.g. Vietnamese tone marks) are 0 cells.
 * - ANSI escape sequences are ignored when measuring, passed through
 *   untouched, and never split when clipping/wrapping.
 * - Grapheme clusters (emoji ZWJ sequences, base + combining marks) are never
 *   split either.
 *
 * Every pad/clip/truncate of user-visible strings in src/tui/ must go through
 * here — never use String.prototype.padEnd/slice directly on display text.
 */
import stringWidth from "string-width";

/** Visible cell width of a string (ANSI ignored, emoji/CJK = 2 cells). */
export function measure(text: string): number {
  return stringWidth(text);
}

// eslint-disable-next-line no-control-regex -- ANSI escape sequences are control chars by definition
const ANSI_RX = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;

/** Split into tokens: ANSI sequences (width 0) vs plain text chunks. */
function tokenize(text: string): Array<{ ansi: boolean; value: string }> {
  const tokens: Array<{ ansi: boolean; value: string }> = [];
  let last = 0;
  for (const m of text.matchAll(ANSI_RX)) {
    if (m.index > last) tokens.push({ ansi: false, value: text.slice(last, m.index) });
    tokens.push({ ansi: true, value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ ansi: false, value: text.slice(last) });
  return tokens;
}

/** Iterate grapheme clusters (keeps emoji ZWJ sequences + combining marks whole). */
function* graphemes(text: string): Generator<string> {
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const seg of segmenter.segment(text)) yield seg.segment;
}

/** Iterate display units: ANSI tokens (width 0) and grapheme clusters. */
function* units(text: string): Generator<{ value: string; width: number }> {
  for (const token of tokenize(text)) {
    if (token.ansi) {
      yield { value: token.value, width: 0 };
    } else {
      for (const g of graphemes(token.value)) yield { value: g, width: stringWidth(g) };
    }
  }
}

/** Slice to the longest prefix fitting `width` cells (no ellipsis). */
export function sliceCells(text: string, width: number): string {
  if (width <= 0) return "";
  if (measure(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const u of units(text)) {
    if (u.width > 0 && used + u.width > width) break;
    out += u.value;
    used += u.width;
  }
  return out;
}

/**
 * Clip to at most `width` cells, appending "…" when truncated.
 * Never splits a grapheme cluster or ANSI sequence.
 */
export function clipCells(text: string, width: number): string {
  const safe = Math.max(1, width);
  if (measure(text) <= safe) return text;
  return sliceCells(text, Math.max(0, safe - 1)) + "…";
}

/** padEnd by display cells (pads with spaces to exactly `width` cells). */
export function padEndCells(text: string, width: number): string {
  const missing = width - measure(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/** padStart by display cells. */
export function padStartCells(text: string, width: number): string {
  const missing = width - measure(text);
  return missing > 0 ? " ".repeat(missing) + text : text;
}

/**
 * Word-wrap to `width` cells. Breaks at spaces when possible; hard-breaks
 * long words at the cell boundary. Returns at least one line per input line.
 * ANSI sequences and grapheme clusters are never split.
 */
export function wrapCells(text: string, width: number): string[] {
  const safe = Math.max(4, width);
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (measure(rawLine) <= safe) {
      out.push(rawLine);
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const word of rawLine.split(/(\s+)/)) {
      if (word === "") continue;
      const wordW = measure(word);
      if (lineW + wordW <= safe) {
        line += word;
        lineW += wordW;
        continue;
      }
      // Word fits on a fresh line → break before it.
      if (wordW <= safe && word.trim() !== "") {
        if (line.trim() !== "") out.push(line.trimEnd());
        line = word.trimStart();
        lineW = measure(line);
        continue;
      }
      // Long word (or whitespace overflow): hard-break by cells.
      for (const u of units(word)) {
        if (u.width > 0 && lineW + u.width > safe) {
          out.push(line);
          line = "";
          lineW = 0;
        }
        if (u.width > 0 && u.value.trim() === "" && line === "") continue; // drop leading ws
        line += u.value;
        lineW += u.width;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
