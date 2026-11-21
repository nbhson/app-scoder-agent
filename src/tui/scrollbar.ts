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
