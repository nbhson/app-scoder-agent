/**
 * Scroll affordances (A5) — pure helpers for the two things that used to be
 * missing while reading an old part of the transcript: knowing NEW content
 * arrived, and knowing how big the backlog is. Framework-free, unit-tested.
 */

/**
 * Rows added since the last render, counted ONLY while the user is scrolled
 * up (offset > 0). At the bottom everything is already on screen — the pill
 * must not nag. Negative deltas (re-estimates, /clear) return 0.
 */
export function newContentPill(prevRows: number, nextRows: number, offset: number): number {
  if (offset <= 0) return 0;
  return Math.max(0, nextRows - prevRows);
}

export interface Thumb {
  /** Track rows, top → bottom; `true` = thumb cell. */
  cells: boolean[];
  /** 0..100 — how much of the transcript is behind the viewport top. */
  pct: number;
}

/**
 * A proportional, positionally-accurate scrollbar for a `track`-row column:
 * thumb length ≈ viewport/content, position mirrors scrollTop (offset counts
 * FROM THE BOTTOM here, same as TuiApp's scrollOffset). Returns null when
 * there is nothing to scroll.
 */
export function scrollThumb(track: number, totalRows: number, offset: number): Thumb | null {
  if (track < 3 || totalRows <= track || offset < 0) return null;
  const size = Math.max(1, Math.round((track * track) / totalRows));
  const free = track - size;
  const maxOffset = totalRows - track;
  // offset counts from the BOTTOM: 0 → thumb sits at the end of the track.
  const pos = maxOffset > 0 ? free - Math.round((Math.min(offset, maxOffset) / maxOffset) * free) : free;
  const cells: boolean[] = [];
  for (let i = 0; i < track; i++) cells.push(i >= pos && i < pos + size);
  return { cells, pct: Math.min(100, Math.round(((maxOffset - Math.min(offset, maxOffset)) / maxOffset) * 100)) };
}

export interface TailAnchorInput {
  /** Viewport height in rows (clientHeight). */
  track: number;
  /** Estimated total rows of the transcript (transcriptWindow().totalRows). */
  totalRows: number;
  /** Estimated maxScroll (totalRows - viewportRows). */
  maxScroll: number;
  /** scrollOffset — rows from the bottom, in ESTIMATE units. */
  offset: number;
  /** transcriptWindow().offset — estimate rows hidden above the mounted window. */
  winOffset: number;
  /** Measured height of the mounted window (contentRef). */
  contentHeight: number;
  hasMeasured: boolean;
  /** True when the mounted window reaches the LAST transcript item. */
  tailMounted: boolean;
}

export interface TailAnchorOutput {
  /** contentOffsetY for the viewport. */
  contentOffset: number;
  /** scrollOffset clamped at the real bottom — 0 while pinned (pill/thumb/status). */
  offset: number;
  /** Real total rows when the tail window is measured, otherwise the estimate. */
  totalRows: number;
}

/**
 * Tail anchor — scrollOffset is an ESTIMATED distance from the bottom; when
 * the estimate counts MORE rows than are really rendered (wide terminals:
 * paragraphs wrap wider than the 60/76/EST_WIDTH assumptions), the estimated
 * bottom sits past the true one. Then with offset > 0, `winOffset` hides rows
 * beyond the mounted window's measured height: the last generated line
 * floats mid-screen with blank below, while pill + thumb still report
 * "scrolled up" (repro: scroll up while streaming, then scroll back down).
 * When the window reaches the last item AND is measured, contentOffset may
 * never exceed `contentHeight - track` — pin it there and treat the view as
 * at-bottom for every offset-derived affordance until the user scrolls up
 * again.
 */
export function tailAnchor(i: TailAnchorInput): TailAnchorOutput {
  const maxVisible = Math.max(0, i.contentHeight - i.track);
  const measurable = i.hasMeasured && i.track >= 3;
  const pinned = measurable && i.tailMounted && i.winOffset > maxVisible;
  const atBottom = measurable && (i.offset === 0 || pinned);
  const topEst = Math.max(0, i.maxScroll - i.offset);
  const realTotal =
    measurable && i.tailMounted ? Math.max(i.track, topEst - i.winOffset + i.contentHeight) : i.totalRows;
  return {
    contentOffset: atBottom ? maxVisible : i.winOffset,
    offset: pinned ? 0 : i.offset,
    totalRows: realTotal,
  };
}
