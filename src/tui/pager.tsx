/**
 * Full-screen viewer (A4) — the escape hatch for every "… truncated" in the
 * transcript: tool output (reducer keeps up to 20k chars), full unified
 * diffs (with word-level highlighting via word-diff.ts), and — wired in P8 —
 * harness-log entries resolved back to their source items.
 *
 * The pager owns the keyboard while mounted (TuiApp gates Input/keybinds
 * through the overlay ref) and its wheel events (mouse tracking is routed
 * here by useScrollMetrics' override while open).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { ChatItem } from "./state.js";
import { wordDiff, type WLine } from "./word-diff.js";
import { clipCells, measure } from "./text-width.js";
import { boxBorderStyle } from "./charset.js";
import { theme } from "./theme.js";

/** One selectable document in the viewer stack (chronological order). */
export interface PagerSource {
  title: string;
  kind: "output" | "diff";
  text: string;
  /** Status suffix shown in the header (e.g. "exit 0 · 1.2s", "+18 -4"). */
  meta: string;
  /** Index into state.items this source was built from (for re-renders). */
  itemId: number;
}

const MAX_SOURCES = 30;

/** Build the viewer stack from transcript tool/diff items (newest last). */
export function pagerSources(items: ChatItem[], cap = MAX_SOURCES): PagerSource[] {
  const out: PagerSource[] = [];
  items.forEach((it, i) => {
    if (it.kind === "tool") {
      const arg =
        typeof it.args.command === "string" ? it.args.command
          : typeof it.args.path === "string" ? it.args.path
            : "";
      out.push({
        title: `${String(it.step).padStart(2, "0")} ▸ ${it.name}${arg ? ` ${arg}` : ""}`,
        kind: "output",
        text: it.output,
        meta: it.ok === null ? "running…" : it.ok ? `ok` : "FAILED",
        itemId: i,
      });
    } else if (it.kind === "diff") {
      out.push({
        title: `${String(it.step).padStart(2, "0")} ▸ ✎ ${it.path}`,
        kind: "diff",
        text: it.text,
        meta: `+${it.added} -${it.removed}${it.truncated ? " · stored diff truncated" : ""}`,
        itemId: i,
      });
    }
  });
  return out.slice(-cap);
}

export interface PagerProps {
  sources: PagerSource[];
  startIndex: number;
  /** Wheel override slot owned by TuiApp (set on mount, cleared on unmount). */
  wheelRef: { current: ((dir: "up" | "down") => void) | null };
  onSave: (source: PagerSource) => void;
  onClose: () => void;
}

export function Pager({ sources, startIndex, wheelRef, onSave, onClose }: PagerProps): React.JSX.Element {
  const { rows, columns } = useWindowSize();
  const [idx, setIdx] = useState(() => Math.max(0, Math.min(startIndex, sources.length - 1)));
  const [offset, setOffset] = useState(0);
  const [wordMode, setWordMode] = useState(true);
  const source = sources[Math.min(idx, sources.length - 1)] ?? sources[0];

  // ── viewport budget ──
  const totalH = Math.max(6, (rows ?? 24) - 7);
  const innerW = Math.max(24, (columns ?? 100) - 10);
  const innerH = totalH - 5; // border(2) + header(1) + footer(1) + margin(1)

  // ── content lines (raw strings; diff gets the word-diff pre-pass) ──
  const rawLines = useMemo(() => {
    if (!source) return [];
    if (source.kind === "diff" && wordMode) return wordDiff(source.text);
    return source.text.length > 0 ? source.text.split("\n").map((t): WLine => ({ kind: "raw", text: t })) : [];
  }, [source, wordMode]);

  // Long lines clip to the viewport (full text stays reachable via `y`).
  const display = rawLines;

  const maxOffset = Math.max(0, display.length - innerH);
  const off = Math.min(offset, maxOffset);

  const scroll = useCallback((d: number) => setOffset((o) => Math.max(0, Math.min(Math.max(0, maxOffset), o + d))), [maxOffset]);
  const jump = useCallback((toBottom: boolean) => setOffset(toBottom ? maxOffset : 0), [maxOffset]);

  // Reset scroll when switching sources.
  const idxRef = useRef(idx);
  if (idxRef.current !== idx) {
    idxRef.current = idx;
    setOffset(0);
  }

  useInput((input, key) => {
    if (key.escape || (input.length === 1 && input.toLowerCase() === "q")) {
      onClose();
      return;
    }
    if (key.upArrow || (input === "k" && !key.ctrl && !key.meta)) return scroll(-1);
    if (key.downArrow || (input === "j" && !key.ctrl && !key.meta)) return scroll(1);
    if (key.pageUp) return scroll(-innerH);
    if (key.pageDown) return scroll(innerH);
    if (key.home || input === "g") return jump(false);
    if (key.end || input === "G") return jump(true);
    if (key.tab) {
      if (sources.length < 2) return;
      const next = key.shift
        ? (idx - 1 + sources.length) % sources.length
        : (idx + 1) % sources.length;
      setIdx(next);
      return;
    }
    if (input === "w" && source?.kind === "diff") return setWordMode((m) => !m);
    if (input === "y" && source) return onSave(source);
  });

  // ── wheel: while mounted the transcript's wheel listener routes here
  // (useScrollMetrics' override). Mouse tracking stays enabled app-wide;
  // the pager must not re-claim raw mode / duplicate enable sequences. ──
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;
  useEffect(() => {
    const handler = (dir: "up" | "down") => scrollRef.current(dir === "up" ? -3 : 3);
    wheelRef.current = handler;
    return () => {
      wheelRef.current = null;
    };
  }, [wheelRef]);

  if (!source) {
    return (
      <Box borderStyle={boxBorderStyle()} borderColor={theme.accent} paddingX={1} flexShrink={0}>
        <Text dimColor>nothing to show yet — esc to close</Text>
      </Box>
    );
  }

  const shown = display.slice(off, off + innerH);
  const pct = display.length === 0 ? 0 : Math.min(100, Math.round(((off + innerH) / display.length) * 100));

  return (
    <Box flexDirection="column" height={totalH} flexShrink={0}>
      <Box
        flexDirection="column"
        borderStyle={boxBorderStyle()}
        borderColor={theme.accent}
        paddingX={1}
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
      >
        {/* Header: title + position + mode badges */}
        <Text>
          <Text color={theme.brand} bold>⎞ </Text>
          <Text bold>{clipCells(source.title, innerW - 30)}</Text>
          <Text dimColor>
            {"  "}{source.meta}
            {sources.length > 1 && <>  · {idx + 1}/{sources.length}</>}
            {source.kind === "diff" && <>{wordMode ? "  · word" : "  · raw"}</>}
          </Text>
        </Text>
        {shown.map((l, i) => (
          <WLineView key={off + i} line={l} width={innerW} />
        ))}
        {display.length === 0 && <Text dimColor>  (empty)</Text>}
      </Box>
      <Text dimColor>
        {` ↑↓/jk scroll · PgUp/PgDn · Home/End · ⇥ next${sources.length > 1 ? ` (${idx + 1}/${sources.length})` : ""}` +
          (source.kind === "diff" ? " · w word/raw" : "") +
          " · y save · q/esc close"}
        {off > 0 || pct < 100 ? `  ·  ${pct}%` : ""}
      </Text>
    </Box>
  );
}

/** One render-ready line: gutter + word-diff segments, clipped to the viewport. */
function WLineView({ line, width }: { line: WLine; width: number }): React.JSX.Element {
  if (line.kind === "raw") return <RawLineView text={clipCells(line.text, width)} />;
  // Gutter ("- " / "+ ") costs 2 cells; segments clip by remaining width.
  let left = width - 2;
  const segs: React.JSX.Element[] = [];
  for (let i = 0; i < line.segs.length && left > 0; i++) {
    let s = line.segs[i];
    const w = measure(s.text);
    if (w <= left) {
      left -= w;
    } else {
      s = { text: clipCells(s.text, left), op: s.op };
      left = 0;
    }
    segs.push(
      s.op === "eq" ? (
        <Text key={i} dimColor>{s.text}</Text>
      ) : (
        <Text key={i} backgroundColor={s.op === "del" ? "redBright" : "greenBright"} color="black">
          {s.text}
        </Text>
      ),
    );
  }
  return (
    <Text>
      <Text color={line.kind === "del" ? theme.error : theme.success}>{line.prefix} </Text>
      {segs}
    </Text>
  );
}

/** raw diff line coloring, same rules as the transcript's DiffLine. */
function RawLineView({ text }: { text: string }): React.JSX.Element {
  if (text.startsWith("@@")) return <Text color={theme.accent}>{text}</Text>;
  if (text.startsWith("+++") || text.startsWith("---")) return <Text bold>{text}</Text>;
  if (text.startsWith("+")) return <Text color={theme.success}>{text}</Text>;
  if (text.startsWith("-")) return <Text color={theme.error}>{text}</Text>;
  return <Text>{text === "" ? " " : text}</Text>;
}
