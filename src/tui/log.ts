/**
 * Harness Log (P8) — pure view-model helpers over `state.log`.
 *
 * The reducer (state.ts) is the single data source; everything here is
 * derivation for the Sidebar tab: filtering, tail-windowing, glyph/color
 * mapping and lazy payload resolution (item → session jsonl fallback).
 * Framework-free so the whole category/merge/anchor matrix is unit-testable.
 */
import { isAsciiMode } from "./charset.js";
import { theme } from "./theme.js";
import type { ChatItem, LogCat, LogEntry } from "./state.js";
import { JsonlLogger } from "../session/logger.js";

export type LogFilter = "ALL" | "LLM" | "TOOL" | "MCP" | "SUB" | "SYS";

export const LOG_FILTER_CYCLE: LogFilter[] = ["ALL", "LLM", "TOOL", "MCP", "SUB", "SYS"];

const BUCKETS: Record<LogFilter, LogCat[] | null> = {
  ALL: null,
  LLM: ["llm"],
  TOOL: ["tool", "shell", "file", "build"],
  MCP: ["mcp"],
  SUB: ["sub"],
  SYS: ["sys", "run", "guard", "perm"],
};

export function filterLog(entries: LogEntry[], f: LogFilter): LogEntry[] {
  const cats = BUCKETS[f];
  return cats ? entries.filter((e) => cats.includes(e.cat)) : entries;
}

// ── glyphs & colors ─────────────────────────────────────────────────────────

const GLYPH: Record<LogCat, { u: string; a: string }> = {
  run: { u: "◆", a: "R" },
  llm: { u: "⇅", a: "L" },
  tool: { u: "▸", a: ">" },
  shell: { u: "⚡", a: "$" },
  file: { u: "✎", a: "*" },
  build: { u: "▣", a: "#" },
  mcp: { u: "◈", a: "M" },
  sub: { u: "⊙", a: "S" },
  guard: { u: "⚠", a: "!" },
  perm: { u: "⛔", a: "?" },
  sys: { u: "·", a: "." },
};

export function logGlyph(cat: LogCat): string {
  const g = GLYPH[cat];
  return isAsciiMode() ? g.a : g.u;
}

export function logColor(e: LogEntry): string {
  switch (e.cat) {
    case "run": return theme.brand;
    case "llm":
    case "perm": return theme.accent;
    case "shell":
    case "guard": return theme.warn;
    case "file": return theme.brand;
    case "build": return e.text.includes("PASS") ? theme.success : theme.error;
    case "tool":
    case "mcp":
    case "sys": return theme.dim;
    case "sub": return theme.thinking;
  }
}

/** Live rows render a `…` suffix so an open stream is distinguishable. */
export function logSuffix(e: LogEntry): string {
  if (!e.meta?.live) return "";
  const bits: string[] = [];
  if (e.meta.chunks) bits.push(`${e.meta.chunks}c`);
  if (e.meta.bytes) bits.push(`${e.meta.bytes >= 1000 ? `${(e.meta.bytes / 1000).toFixed(1)}k` : e.meta.bytes}B`);
  if (e.meta.count) bits.push(`▸${e.meta.count}`);
  return ` …${bits.length > 0 ? ` ${bits.join(" ")}` : ""}`;
}

// ── formatting ──────────────────────────────────────────────────────────────

const p2 = (n: number): string => String(n).padStart(2, "0");

/** Local HH:MM:SS.d — one fixed-width time column for every row. */
export function fmtLogTs(ts: number): string {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
}

export interface LogView {
  filter: LogFilter;
  /** Selection anchored by entry id — survives ring growth and eviction. */
  selId: number | null;
  /** Rows hidden below the window's bottom edge; 0 = follow the tail. */
  offset: number;
  detail: boolean;
}

export const DEFAULT_LOG_VIEW: LogView = { filter: "ALL", selId: null, offset: 0, detail: false };

// ── tail window (offset counts rows hidden at the BOTTOM, 0 = follow) ──────

export interface LogWindow {
  rows: LogEntry[];
  /** Absolute index of the first visible row (for stable keys). */
  first: number;
  maxOffset: number;
}

export function logWindow(entries: LogEntry[], availRows: number, offset: number): LogWindow {
  const maxOffset = Math.max(0, entries.length - availRows);
  const off = Math.min(Math.max(0, offset), maxOffset);
  const end = entries.length - off;
  const start = Math.max(0, end - availRows);
  return { rows: entries.slice(start, end), first: start, maxOffset };
}

// ── selection anchors (survive ring-buffer growth & eviction) ───────────────

/** Move selection by `delta` within `visibleIds`, starting at the newest. */
export function moveSelection(visibleIds: number[], selId: number | null, delta: number): number | null {
  if (visibleIds.length === 0) return null;
  const at = selId == null ? visibleIds.length - 1 : visibleIds.indexOf(selId);
  if (at === -1) {
    // Anchored entry evicted — clamp from the nearest end in move direction.
    const i = Math.max(0, Math.min(visibleIds.length - 1, (selId ?? 0) < visibleIds[0] ? 0 : visibleIds.length - 1));
    return visibleIds[delta < 0 ? 0 : visibleIds.length - 1] ?? visibleIds[i];
  }
  const next = Math.max(0, Math.min(visibleIds.length - 1, at + delta));
  return visibleIds[next];
}

/**
 * Nearest visible row to the selection inside the CURRENT window — the tail
 * window follows the cursor: offset moves so selId stays on screen.
 */
export function followOffset(entries: LogEntry[], availRows: number, offset: number, selId: number | null): number {
  if (selId == null) return offset;
  const idx = entries.findIndex((e) => e.id === selId);
  if (idx === -1) return offset;
  const maxOffset = Math.max(0, entries.length - availRows);
  const off = Math.min(Math.max(0, offset), maxOffset);
  const start = entries.length - off - availRows;
  if (idx < start) return Math.min(maxOffset, off + (start - idx));
  if (idx >= entries.length - off) return Math.max(0, off - (idx - (entries.length - off - 1)));
  return off;
}

// ── payload resolution (⏎ in the log → P3 pager) ───────────────────────────

export interface LogPayload {
  title: string;
  kind: "output" | "diff";
  text: string;
  meta: string;
}

/** The row's own text + counters — payload when nothing richer exists. */
function selfPayload(entry: LogEntry): LogPayload {
  return { title: `${entry.cat} · ${entry.text}`, kind: "output", text: entry.text + detailMeta(entry), meta: entry.cat };
}

/** Diff payload for a `file` row (searches items back-to-front by step). */
function filePayload(entry: LogEntry, items: ChatItem[]): LogPayload | null {
  const step = entry.ref?.step;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "diff" && (step == null || it.step === step)) {
      return { title: `✎ ${it.path}`, kind: "diff", text: it.text, meta: `+${it.added} -${it.removed}${it.truncated ? " · stored diff truncated" : ""}` };
    }
  }
  return null;
}

/** args+output payload for a `tool`/`shell` row; session jsonl when evicted. */
function toolPayload(
  entry: LogEntry,
  items: ChatItem[],
  session?: { workdir: string; sessionId: string },
): LogPayload | null {
  const ref = entry.ref;
  if (!ref) return null;
  const name = ref.name ?? "";
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "tool") continue;
    const match = ref.callId ? it.callId === ref.callId : it.name === name && it.step === ref.step;
    if (!match) continue;
    const args = JSON.stringify(it.args, null, 1);
    const verdict = it.ok === null ? "running" : it.ok ? "ok" : "FAILED";
    return {
      title: `${name} ${Object.values(it.args)[0] ?? ""}`.slice(0, 80),
      kind: "output",
      text: `# args\n${args}\n\n# output (${verdict})\n${it.output || "(no output)"}`,
      meta: verdict,
    };
  }
  // Evicted from MAX_ITEMS — fall back to the persisted session events.
  if (session) {
    const out = payloadFromSessionLog(session.workdir, session.sessionId, ref.callId, name);
    if (out != null) {
      return { title: `${name} (from session log)`, kind: "output", text: out, meta: "evicted item — resolved from .scoder/logs" };
    }
  }
  return null;
}

/** Resolve full payload from the transcript; evicted items fall back to the
 *  session jsonl (best-effort — null when nothing can be found). */
export function resolveLogPayload(
  entry: LogEntry,
  items: ChatItem[],
  session?: { workdir: string; sessionId: string },
): LogPayload | null {
  if (!entry.ref) return selfPayload(entry); // row + counters IS the payload
  if (entry.cat === "file") return filePayload(entry, items) ?? selfPayload(entry);
  if (entry.cat === "tool" || entry.cat === "shell") return toolPayload(entry, items, session) ?? selfPayload(entry);
  return selfPayload(entry); // llm/build/sub/…: counters are all there is
}

/** Session jsonl fallback — the reducer's ring evicts items, the log file doesn't. */
export function payloadFromSessionLog(
  workdir: string,
  sessionId: string,
  callId: string | undefined,
  name: string,
): string | null {
  const rows = JsonlLogger.read(workdir, sessionId);
  if (!rows) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as { type?: string; id?: string; name?: string; output?: unknown };
    if (r.type !== "tool_result") continue;
    if (callId ? r.id === callId : r.name === name) {
      return typeof r.output === "string" ? r.output : null;
    }
  }
  return null;
}

/** Full counters for the DETAIL panel / payload header. */
export function detailMeta(e: LogEntry): string {
  const m = e.meta;
  if (!m) return "";
  const bits: string[] = [];
  if (m.tokensIn != null || m.tokensOut != null) bits.push(`in ${m.tokensIn ?? 0} out ${m.tokensOut ?? 0}${m.cached ? ` cache ${m.cached}` : ""}`);
  if (m.ms != null) bits.push(`${(m.ms / 1000).toFixed(1)}s`);
  if (m.chunks != null) bits.push(`${m.chunks} chunks`);
  if (m.bytes != null) bits.push(`${m.bytes} bytes`);
  if (m.count != null) bits.push(`${m.count} ticks`);
  if (m.exit != null) bits.push(`exit ${m.exit ? 0 : 1}`);
  if (m.pct != null) bits.push(`${m.pct}% ctx`);
  return bits.length > 0 ? `\n${bits.join(" · ")}` : "";
}

/** DETAIL panel rows (≤8): summary + meta + pointer, each cell-clipped. */
export function logDetailLines(entry: LogEntry, width: number, clip: (s: string, w: number) => string): string[] {
  const out: string[] = [];
  out.push(clip(`${entry.cat.toUpperCase()} · ${entry.text}`, width));
  const meta = detailMeta(entry).trim();
  if (meta) out.push(clip(meta, width));
  if (entry.ref) {
    out.push(clip(`ref step ${entry.ref.step}${entry.ref.callId ? ` · call ${String(entry.ref.callId).slice(0, 12)}` : ""}${entry.ref.name ? ` · ${entry.ref.name}` : ""}`, width));
  }
  out.push(clip(`${fmtLogTs(entry.ts)} · id ${entry.id}`, width));
  return out.slice(0, 8);
}
