/**
 * Flowchart layout engine — real graph rendering in the terminal (P9).
 *
 * Pipeline: mermaid source → parse (nodes, shapes, arrows) → rank (longest
 * path, cycle-safe) → order (barycenter sweeps) → size boxes → place →
 * rasterize into a cell grid that carries a per-cell *kind*, so the Ink layer
 * can color box borders, labels and edges separately.
 *
 * Two placement modes:
 *  - `layered` — Sugiyama-style bands, one layer per rank. Used whenever the
 *    graph fits the pane (the common case for branching flowcharts). When the
 *    height budget is the only blocker, the routing band tightens (3 → 2 → 1)
 *    before the graph gives up its shape.
 *  - `strip`   — topological order flowed into wrapped rows of boxes joined by
 *    `──▶`, with a `┌───┘` connector where the chain wraps. Used for long
 *    chains (version timelines) that would be taller than the viewport — and
 *    ONLY chains: strip draws edges between consecutive nodes in the order,
 *    so a branching graph would lose most of its edges. When the drawn share
 *    is too low, strip returns null and the caller degrades to the summary.
 *
 * Pure module: no Ink, no I/O, never throws. Every failure path returns null
 * so diagram.tsx falls back to the structured summary — the TUI shows a
 * complete graph or an honest summary, never a clipped drawing.
 *
 * Known approximations (documented in src/tui/README.md):
 *  - mermaid shapes collapse to three corner styles (rect / round / chamfer);
 *  - subgraphs are flattened into their nodes (a note names them);
 *  - edges that close a cycle are listed as notes instead of drawn;
 *  - an edge label with no free run wide enough is dropped and noted.
 */
import { charset } from "../charset.js";
import { clipCells, measure, wrapCells } from "../text-width.js";

// ── Geometry budget ─────────────────────────────────────────────────────────

const GAP = 2;          // cross-axis gap between sibling boxes
const MARGIN = 2;       // cross-axis gutters reserved for detour channels
const BAND = 3;         // routing rows between layers (elbows + labels)
const STRIP_GAP = 3;    // gap between strip boxes — wide enough for `──▶`
const STRIP_BAND = 2;   // rows between strip rows — holds the wrap connector
const MAX_NODES = 80;
const MAX_EDGES = 200;
/** Label width caps, widest first: the first one that fits the pane wins. */
const LAYERED_CAPS = [22, 16, 12, 10];
const STRIP_CAPS = [26, 20, 14, 10];
/** Height budget for a drawn graph — anything taller degrades to the summary. */
export const MAX_GRAPH_ROWS = 40;

// ── Model ───────────────────────────────────────────────────────────────────

export type NodeShape = "rect" | "round" | "diamond" | "circle" | "hex" | "cylinder" | "flag";
export type EdgeStyle = "solid" | "dotted" | "thick";
export type Direction = "TD" | "TB" | "BT" | "LR" | "RL";

export interface FlowNode { id: string; label: string; shape: NodeShape }
export interface FlowEdge { from: string; to: string; label: string; style: EdgeStyle }

export interface FlowGraph {
  direction: Direction;
  nodes: FlowNode[];
  edges: FlowEdge[];
  notes: string[];
}

export type CellKind = "empty" | "box" | "label" | "edge" | "arrow" | "elabel";

export interface Seg { text: string; kind: CellKind }

export interface Raster {
  rows: Seg[][];
  width: number;
  height: number;
  notes: string[];
  mode: "layered" | "strip";
  direction: string;
  nodes: number;
  edges: number;
}

// ── 1. Label cleanup (shared with the summary renderer) ─────────────────────

const HTML_BREAK_RX = /<\s*br\s*\/?\s*>/gi;
const HTML_TAG_RX = /<\s*\/?\s*[a-z][^>]*>/gi;
const ENTITY_RX = /&(#x?[0-9a-f]+|[a-z]+);/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/**
 * Mermaid label → display text. `<br/>` is a LINE BREAK inside a mermaid node,
 * so printing it literally is wrong: it becomes a space. Other tags are
 * dropped, numeric/named entities decoded, quotes and repeated spaces
 * collapsed.
 */
export function cleanMermaidLabel(raw: string): string {
  let out = raw.trim().replace(HTML_BREAK_RX, " ").replace(HTML_TAG_RX, "");
  out = out.replace(ENTITY_RX, (whole: string, entity: string) => {
    if (entity[0] !== "#") return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    const hex = entity[1] === "x" || entity[1] === "X";
    const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 31 ? String.fromCharCode(code) : whole;
  });
  return out.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
}

// ── 2. Parsing ──────────────────────────────────────────────────────────────

/** Shape wrappers, longest opener first so `[[x]]` never parses as `[x]`. */
const SHAPE_DEFS: Array<[string, string, NodeShape]> = [
  ["[[", "]]", "rect"],
  ["([", ")]", "round"],
  ["[(", ")]", "cylinder"],
  ["((", "))", "circle"],
  ["{{", "}}", "hex"],
  ["[", "]", "rect"],
  ["(", ")", "round"],
  ["{", "}", "diamond"],
  [">", "]", "flag"],
];

interface ArrowSpec { text: string; style: EdgeStyle; head: "fwd" | "back" | "both" | "open" }

const ARROW_SPECS: ArrowSpec[] = [
  { text: "<-.->", style: "dotted", head: "both" },
  { text: "<-->", style: "solid", head: "both" },
  { text: "<==>", style: "thick", head: "both" },
  { text: "x--x", style: "solid", head: "open" },
  { text: "o--o", style: "solid", head: "open" },
  { text: "<--x", style: "solid", head: "back" },
  { text: "--->", style: "solid", head: "fwd" },
  { text: "-.->", style: "dotted", head: "fwd" },
  { text: "==>", style: "thick", head: "fwd" },
  { text: "-->", style: "solid", head: "fwd" },
  { text: "<--", style: "solid", head: "back" },
  { text: "---", style: "solid", head: "open" },
  { text: "===", style: "thick", head: "open" },
  { text: "-.-", style: "dotted", head: "open" },
  { text: "->", style: "solid", head: "fwd" },
  { text: "=>", style: "thick", head: "fwd" },
  { text: "--", style: "solid", head: "open" },
  { text: "<-", style: "solid", head: "back" },
];

const ID_RX = /^[\p{L}\p{N}_][\p{L}\p{N}_\-.]*/u;

type Tok =
  | { t: "node"; id: string; label?: string; shape?: NodeShape }
  | { t: "edge"; spec: ArrowSpec; label: string };

function skipSpace(line: string, i: number): number {
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
}

function readShape(line: string, i: number): { text: string; shape: NodeShape; end: number } | null {
  for (const [open, close, shape] of SHAPE_DEFS) {
    if (!line.startsWith(open, i)) continue;
    const end = line.indexOf(close, i + open.length);
    if (end === -1) continue;
    return { text: line.slice(i + open.length, end), shape, end: end + close.length };
  }
  return null;
}

interface ArrowHit { spec: ArrowSpec; start: number; end: number }

function matchArrow(line: string, i: number): ArrowHit | null {
  for (const spec of ARROW_SPECS) {
    if (line.startsWith(spec.text, i)) return { spec, start: i, end: i + spec.text.length };
  }
  return null;
}

/** Next arrow at/after `from`, skipping node shapes so `-->` inside a label is safe. */
function findNextArrow(line: string, from: number): ArrowHit | null {
  for (let i = from; i < line.length; i++) {
    const shape = readShape(line, i);
    if (shape) { i = shape.end - 1; continue; }
    const hit = matchArrow(line, i);
    if (hit) return hit;
  }
  return null;
}

/** Scan one statement into alternating node/edge tokens (`A --> B --> C` works). */
function scanStatement(line: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  for (;;) {
    i = skipSpace(line, i);
    const id = ID_RX.exec(line.slice(i))?.[0];
    if (!id) return toks.length >= 2 ? toks : null;
    i += id.length;
    const shape = readShape(line, i);
    if (shape) {
      toks.push({ t: "node", id, label: shape.text, shape: shape.shape });
      i = shape.end;
    } else {
      const cls = /^:::[\w-]+/.exec(line.slice(i)); // `A:::someClass`
      if (cls) i += cls[0].length;
      toks.push({ t: "node", id });
    }
    i = skipSpace(line, i);
    let arrow = matchArrow(line, i);
    if (!arrow) break;
    i = arrow.end;
    let label = "";
    const bar = skipSpace(line, i);
    if (line[bar] === "|") {
      const close = line.indexOf("|", bar + 1);
      if (close !== -1) { label = line.slice(bar + 1, close); i = close + 1; }
    } else if (arrow.spec.head === "open") {
      // `A -- yes --> B`: open arrow, label text, then the real arrow head.
      const next = findNextArrow(line, i);
      if (next && next.start > i) {
        label = line.slice(i, next.start).trim();
        arrow = next;
        i = next.end;
      }
    }
    toks.push({ t: "edge", spec: arrow.spec, label: cleanMermaidLabel(label) });
  }
  return toks.length >= 2 ? toks : null;
}

function stripComment(line: string): string {
  const i = line.indexOf("%%");
  return (i === -1 ? line : line.slice(0, i)).trim();
}

/** Parse a mermaid `graph`/`flowchart` block; null for anything else. */
export function parseFlowchart(lines: string[]): FlowGraph | null {
  const rows = lines.map(stripComment).filter((l) => l !== "");
  if (rows.length === 0) return null;
  const header = /^(?:graph|flowchart)(?:\s+(TB|BT|TD|RL|LR))?\b/i.exec(rows[0]);
  if (!header) return null;
  const direction = (header[1] ?? "TD").toUpperCase() as Direction;

  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  const touch = (id: string, label?: string, shape?: NodeShape): void => {
    const node = nodes.get(id) ?? { id, label: id, shape: "rect" as NodeShape };
    if (label !== undefined && label !== "") {
      node.label = cleanMermaidLabel(label);
      node.shape = shape ?? node.shape;
    }
    nodes.set(id, node);
  };

  for (let li = 1; li < rows.length; li++) {
    const line = rows[li];
    if (/^subgraph\b/i.test(line)) {
      const title = cleanMermaidLabel(line.replace(/^subgraph\b/i, "").replace(/\[[^\]]*\]|\([^)]*\)/g, ""));
      if (title) notes.push(`subgraph flattened: ${title}`);
      continue;
    }
    if (/^end\b/i.test(line)) continue;
    // Styling / interaction statements do not change the graph shape.
    if (/^(direction|style|classDef|class|linkStyle|click|callback|accTitle|accDescr)\b/i.test(line)) continue;

    const toks = scanStatement(line);
    if (!toks) continue;
    let prev: string | null = null;
    let pending: Extract<Tok, { t: "edge" }> | null = null;
    for (const tok of toks) {
      if (tok.t === "edge") { pending = tok; continue; }
      touch(tok.id, tok.label, tok.shape);
      if (pending && prev) {
        if (prev === tok.id) {
          notes.push(`self-loop omitted: ${nodes.get(prev)?.label ?? prev}`);
        } else if (edges.length < MAX_EDGES) {
          const reverse = pending.spec.head === "back";
          const from = reverse ? tok.id : prev;
          const to = reverse ? prev : tok.id;
          const key = `${from}\u0000${to}\u0000${pending.label}\u0000${pending.spec.style}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ from, to, label: pending.label, style: pending.spec.style });
          }
        }
      }
      prev = tok.id;
      pending = null;
    }
  }

  if (nodes.size === 0 || nodes.size > MAX_NODES) return null;
  return { direction, nodes: [...nodes.values()], edges, notes: dedupe(notes).slice(0, 4) };
}

// ── 3. Ranking & ordering ───────────────────────────────────────────────────

interface Ranked {
  /** Node ids grouped by rank, in display order within each layer. */
  layers: string[][];
  /** Edges that close a cycle — excluded from ranking and from drawing. */
  back: Set<FlowEdge>;
}

/** Longest-path ranking with DFS cycle breaking, then barycenter ordering. */
function rankLayers(g: FlowGraph): Ranked {
  const ids = g.nodes.map((n) => n.id);
  const out = new Map<string, FlowEdge[]>(ids.map((id) => [id, []]));
  for (const e of g.edges) out.get(e.from)?.push(e);

  // 1. mark back edges (target still on the DFS stack ⇒ cycle closer)
  const state = new Map<string, number>(); // 0 unseen · 1 on stack · 2 done
  const back = new Set<FlowEdge>();
  const stack: Array<{ id: string; i: number }> = [];
  for (const root of ids) {
    if (state.get(root)) continue;
    state.set(root, 1);
    stack.push({ id: root, i: 0 });
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const list = out.get(frame.id) ?? [];
      if (frame.i >= list.length) { state.set(frame.id, 2); stack.pop(); continue; }
      const edge = list[frame.i++];
      const mark = state.get(edge.to) ?? 0;
      if (mark === 1) back.add(edge);
      else if (mark === 0) { state.set(edge.to, 1); stack.push({ id: edge.to, i: 0 }); }
    }
  }

  // 2. Kahn topological order + longest-path rank over the acyclic part
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const fwd = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of g.edges) {
    if (back.has(e)) continue;
    fwd.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const topo: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topo.push(id);
    for (const next of fwd.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      const left = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  for (const id of ids) if (!topo.includes(id)) topo.push(id);

  const depth = ids.reduce((max, id) => Math.max(max, (rank.get(id) ?? 0) + 1), 0);
  const layers: string[][] = Array.from({ length: depth }, () => []);
  for (const id of topo) layers[rank.get(id) ?? 0].push(id);

  // 3. barycenter sweeps to reduce crossings
  const neighbors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of g.edges) {
    if (back.has(e)) continue;
    neighbors.get(e.from)?.push(e.to);
    neighbors.get(e.to)?.push(e.from);
  }
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order: number[] = [];
    for (let i = 1; i < depth; i++) order.push(down ? i : depth - 1 - i);
    for (const li of order) {
      const ref = layers[down ? li - 1 : li + 1];
      if (!ref || ref.length === 0) continue;
      const pos = new Map(ref.map((id, idx) => [id, idx]));
      layers[li] = layers[li]
        .map((id, idx) => {
          const near = (neighbors.get(id) ?? [])
            .map((n) => pos.get(n))
            .filter((p): p is number => p !== undefined);
          const b = near.length > 0 ? near.reduce((s, p) => s + p, 0) / near.length : idx;
          return { id, idx, b };
        })
        .sort((a, b) => a.b - b.b || a.idx - b.idx)
        .map((x) => x.id);
    }
  }
  return { layers: layers.filter((L) => L.length > 0), back };
}

// ── 4. Canvas ───────────────────────────────────────────────────────────────

const UP = 1, RIGHT = 2, DOWN = 4, LEFT = 8;

function lineGlyph(mask: number, style: EdgeStyle): string {
  const horizontal = (mask & (RIGHT | LEFT)) !== 0 && (mask & (UP | DOWN)) === 0;
  const vertical = (mask & (UP | DOWN)) !== 0 && (mask & (RIGHT | LEFT)) === 0;
  if (style === "thick") {
    if (horizontal) return charset.hHeavy;
    if (vertical) return charset.vHeavy;
  } else if (style === "dotted") {
    if (horizontal) return charset.hDotted;
    if (vertical) return charset.vDotted;
  }
  return charset.line[mask] ?? "+";
}

interface Rect { x: number; y: number; w: number; h: number }

class Canvas {
  readonly chars: string[][];
  readonly kinds: CellKind[][];
  readonly masks: number[][];
  readonly styles: EdgeStyle[][];

  constructor(readonly w: number, readonly h: number) {
    this.chars = Array.from({ length: h }, () => new Array<string>(w).fill(" "));
    this.kinds = Array.from({ length: h }, () => new Array<CellKind>(w).fill("empty"));
    this.masks = Array.from({ length: h }, () => new Array<number>(w).fill(0));
    this.styles = Array.from({ length: h }, () => new Array<EdgeStyle>(w).fill("solid"));
  }

  private ok(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  busy(x: number, y: number): boolean {
    return this.ok(x, y) && this.kinds[y][x] !== "empty";
  }

  /**
   * Can a channel be drawn through this cell? `allowShared` lets a second
   * edge merge into an existing line (junction) instead of giving up — used
   * only after every clean route is exhausted, so the picture stays readable.
   */
  private passable(x: number, y: number, allowShared: boolean): boolean {
    if (!this.ok(x, y)) return false;
    const kind = this.kinds[y][x];
    return kind === "empty" || (allowShared && kind === "edge");
  }

  freeH(y: number, x1: number, x2: number, allowShared = false): boolean {
    const [a, b] = x1 <= x2 ? [x1, x2] : [x2, x1];
    for (let x = a; x <= b; x++) if (!this.passable(x, y, allowShared)) return false;
    return true;
  }

  freeV(x: number, y1: number, y2: number, allowShared = false): boolean {
    const [a, b] = y1 <= y2 ? [y1, y2] : [y2, y1];
    for (let y = a; y <= b; y++) if (!this.passable(x, y, allowShared)) return false;
    return true;
  }

  /**
   * Free run along the RANK axis at a fixed cross coordinate. TD: rank is
   * vertical (a column); LR: rank is horizontal (a row).
   */
  freeRank(atCross: number, r1: number, r2: number, rankVertical: boolean, allowShared = false): boolean {
    return rankVertical ? this.freeV(atCross, r1, r2, allowShared) : this.freeH(atCross, r1, r2, allowShared);
  }

  /** Free run along the CROSS axis at a fixed rank coordinate. */
  freeCross(atRank: number, c1: number, c2: number, rankVertical: boolean, allowShared = false): boolean {
    return rankVertical ? this.freeH(atRank, c1, c2, allowShared) : this.freeV(atRank, c1, c2, allowShared);
  }

  private put(x: number, y: number, ch: string, kind: CellKind): void {
    if (!this.ok(x, y)) return;
    this.chars[y][x] = ch;
    this.kinds[y][x] = kind;
    this.masks[y][x] = 0;
  }

  /** Add connection arms to a cell; crossing lines merge into one glyph. */
  line(x: number, y: number, mask: number, style: EdgeStyle): void {
    if (!this.ok(x, y)) return;
    const kind = this.kinds[y][x];
    if (kind === "box" || kind === "label" || kind === "arrow") return;
    this.kinds[y][x] = "edge";
    this.masks[y][x] |= mask;
    if (style !== "solid") this.styles[y][x] = style;
  }

  hLine(y: number, x1: number, x2: number, style: EdgeStyle): void {
    const [a, b] = x1 <= x2 ? [x1, x2] : [x2, x1];
    for (let x = a; x <= b; x++) {
      const mask = a === b ? RIGHT | LEFT : x === a ? RIGHT : x === b ? LEFT : RIGHT | LEFT;
      this.line(x, y, mask, style);
    }
  }

  vLine(x: number, y1: number, y2: number, style: EdgeStyle): void {
    const [a, b] = y1 <= y2 ? [y1, y2] : [y2, y1];
    for (let y = a; y <= b; y++) {
      const mask = a === b ? UP | DOWN : y === a ? DOWN : y === b ? UP : UP | DOWN;
      this.line(x, y, mask, style);
    }
  }

  arrow(x: number, y: number, dir: "up" | "right" | "down" | "left"): void {
    if (!this.ok(x, y)) return;
    if (this.kinds[y][x] === "box" || this.kinds[y][x] === "label") return;
    const ch = dir === "up" ? charset.arrowUp : dir === "right" ? charset.arrowRight
      : dir === "down" ? charset.arrowDown : charset.arrowLeft;
    this.put(x, y, ch, "arrow");
  }

  /**
   * Write text at a cell. Busy cells are skipped unless `overwriteLines`,
   * which lets an edge label break a line (mermaid draws labels on the
   * connector) while never touching box borders or other text.
   */
  text(x: number, y: number, str: string, kind: CellKind, overwriteLines = false): void {
    let cx = x;
    for (const seg of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(str)) {
      const width = measure(seg.segment);
      if (cx < 0) { cx += width; continue; }
      if (cx + width > this.w) break;
      const existing = this.ok(cx, y) ? this.kinds[y][cx] : "empty";
      const blocked = existing !== "empty" && !(overwriteLines && existing === "edge");
      if (!blocked) {
        this.put(cx, y, seg.segment, kind);
        for (let k = 1; k < width; k++) this.put(cx + k, y, " ", kind);
      }
      cx += width;
    }
  }

  /** Node box: border from `cornersFor(shape)` + centered label lines. */
  box(rect: Rect, lines: string[], shape: NodeShape): void {
    const { x, y, w, h } = rect;
    if (w < 5 || h < 3) {
      this.text(x, y, clipCells(lines[0] ?? "", Math.max(1, w)), "label");
      return;
    }
    const [tl, tr, br, bl] = cornersFor(shape);
    this.put(x, y, tl, "box");
    this.put(x + w - 1, y, tr, "box");
    this.put(x + w - 1, y + h - 1, br, "box");
    this.put(x, y + h - 1, bl, "box");
    for (let i = x + 1; i < x + w - 1; i++) {
      this.put(i, y, charset.h, "box");
      this.put(i, y + h - 1, charset.h, "box");
    }
    for (let j = y + 1; j < y + h - 1; j++) {
      this.put(x, j, charset.v, "box");
      this.put(x + w - 1, j, charset.v, "box");
    }
    const inner = w - 4;
    lines.forEach((line, i) => {
      const row = y + 1 + i;
      if (row >= y + h - 1) return;
      const pad = Math.max(0, Math.floor((inner - measure(line)) / 2));
      this.text(x + 2 + pad, row, line, "label");
    });
  }

  /** Resolve glyphs from masks, trim trailing blanks, group runs into segments. */
  toRows(): Seg[][] {
    const rows: Seg[][] = [];
    for (let y = 0; y < this.h; y++) {
      const segs: Seg[] = [];
      let text = "";
      let kind: CellKind = "empty";
      let last = -1;
      for (let x = 0; x < this.w; x++) {
        const cellKind = this.kinds[y][x];
        const ch = cellKind === "edge" ? lineGlyph(this.masks[y][x], this.styles[y][x]) : this.chars[y][x];
        if (cellKind !== kind) {
          if (text !== "") segs.push({ text, kind });
          kind = cellKind;
          text = "";
        }
        text += ch;
        if (cellKind !== "empty") last = x;
      }
      if (text !== "") segs.push({ text, kind });
      rows.push(cutToLast(segs, last));
    }
    return rows;
  }
}

/** Drop the trailing empty run so rows carry no padding spaces. */
function cutToLast(segs: Seg[], last: number): Seg[] {
  if (last < 0) return [];
  const out: Seg[] = [];
  let used = 0;
  for (const seg of segs) {
    if (used > last) break;
    const width = measure(seg.text);
    if (used + width > last + 1) out.push({ text: seg.text.slice(0, last + 1 - used), kind: seg.kind });
    else out.push(seg);
    used += width;
  }
  return out;
}

function cornersFor(shape: NodeShape): string[] {
  if (shape === "diamond") return charset.cornerDiamond;
  if (shape === "round" || shape === "circle" || shape === "hex") return charset.cornerRound;
  return charset.cornerRect;
}

// ── 5. Boxes & shared placement helpers ─────────────────────────────────────

interface BoxSize { lines: string[]; w: number; h: number }

/** Wrap each label into ≤ maxLines lines of ≤ cap-4 cells, then size its box. */
function sizeBoxes(g: FlowGraph, cap: number, maxLines: number): Map<string, BoxSize> {
  const sizes = new Map<string, BoxSize>();
  const inner = Math.max(1, cap - 4);
  for (const node of g.nodes) {
    let lines = wrapCells(node.label || node.id, inner);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = clipCells(lines[maxLines - 1], inner);
    }
    const widest = lines.reduce((max, l) => Math.max(max, measure(l)), 1);
    sizes.set(node.id, { lines, w: widest + 4, h: lines.length + 2 });
  }
  return sizes;
}

interface Box {
  node: FlowNode;
  lines: string[];
  rect: Rect;
  /** Abstract placement: rank axis span + cross axis span. */
  rank0: number;
  rank1: number;
  cross0: number;
  cross1: number;
  crossMid: number;
}

/** Abstract point: `r` along the rank axis, `c` along the cross axis. */
interface Pt { r: number; c: number }

function toXY(p: Pt, rankVertical: boolean): { x: number; y: number } {
  return rankVertical ? { x: p.c, y: p.r } : { x: p.r, y: p.c };
}

function finalize(cv: Canvas, meta: Omit<Raster, "rows" | "width" | "height">): Raster {
  const rows = crop(cv.toRows());
  const width = rows.reduce((max, segs) => Math.max(max, segs.reduce((s, seg) => s + measure(seg.text), 0)), 0);
  return { ...meta, rows, width, height: rows.length, notes: dedupe(meta.notes).slice(0, 4) };
}

/**
 * Drop the unused gutters: leading/trailing blank rows, and the blank column
 * offset shared by every row (a detour channel that was never needed costs
 * the reader nothing).
 */
function crop(rows: Seg[][]): Seg[][] {
  const empty = (segs: Seg[]): boolean => segs.length === 0;
  let top = 0, bottom = rows.length;
  while (top < bottom && empty(rows[top])) top++;
  while (bottom > top && empty(rows[bottom - 1])) bottom--;
  const body = rows.slice(top, bottom);
  let indent = Number.POSITIVE_INFINITY;
  for (const segs of body) {
    const first = segs[0];
    const lead = first !== undefined && first.kind === "empty" ? measure(first.text) : 0;
    indent = Math.min(indent, lead);
  }
  if (!Number.isFinite(indent) || indent <= 0) return body;
  return body.map((segs) => {
    const [first, ...rest] = segs;
    if (first === undefined || first.kind !== "empty") return segs;
    const left = measure(first.text) - indent;
    return left > 0 ? [{ text: " ".repeat(left), kind: "empty" as CellKind }, ...rest] : rest;
  });
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((s) => s !== ""))];
}

// ── 6. Layered layout ───────────────────────────────────────────────────────

interface LayoutOpts {
  width: number;
  maxRows: number;
  cap: number;
  /** Layered only: routing rows between ranks (default BAND). */
  band?: number;
}

/**
 * One band per rank. `BT`/`RL` are laid out as `TD`/`LR` on reversed edges and
 * the arrowheads are moved back to the upstream end, so the picture still
 * reads in the direction the author asked for.
 */
function layeredLayout(g: FlowGraph, opts: LayoutOpts): Raster | null {
  const band = opts.band ?? BAND;
  const rankVertical = g.direction !== "LR" && g.direction !== "RL";
  const flip = g.direction === "BT" || g.direction === "RL";
  const graph: FlowGraph = flip
    ? { ...g, edges: g.edges.map((e) => ({ ...e, from: e.to, to: e.from })) }
    : g;

  const { layers, back } = rankLayers(graph);
  if (layers.length === 0) return null;
  // A cap that would split a WORD is rejected: boxes get taller, not chopped
  // up. Chains with long single words fall through to strip layout, which has
  // a wider cap and wraps at box level.
  const wordsFit = graph.nodes.every((n) => {
    const longest = (n.label || n.id).split(/\s+/).reduce((m, w) => Math.max(m, measure(w)), 0);
    return longest <= opts.cap - 4;
  });
  if (!wordsFit) return null;
  const sizes = sizeBoxes(graph, opts.cap, 2);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const crossOf = (id: string): number => (rankVertical ? sizes.get(id)!.w : sizes.get(id)!.h);
  const rankOf = (id: string): number => (rankVertical ? sizes.get(id)!.h : sizes.get(id)!.w);

  const layerCross = layers.map((L) => L.reduce((s, id) => s + crossOf(id), 0) + GAP * (L.length - 1));
  const innerCross = layerCross.reduce((m, v) => Math.max(m, v), 0);
  // Side gutters: a long edge that has to skip a layer detours through them
  // instead of being dropped (see the Z-route candidates in `routeEdge`).
  const totalCross = innerCross + MARGIN * 2;

  const boxes = new Map<string, Box>();
  let rank = 0;
  layers.forEach((L, li) => {
    let c = MARGIN + Math.floor((innerCross - layerCross[li]) / 2);
    for (const id of L) {
      const size = sizes.get(id)!;
      const node = byId.get(id)!;
      const cr = crossOf(id);
      const rr = rankOf(id);
      const p = toXY({ r: rank, c }, rankVertical);
      boxes.set(id, {
        node,
        lines: size.lines,
        rect: { x: p.x, y: p.y, w: size.w, h: size.h },
        rank0: rank,
        rank1: rank + rr - 1,
        cross0: c,
        cross1: c + cr,
        crossMid: c + Math.floor(cr / 2),
      });
      c += cr + GAP;
    }
    rank += L.reduce((max, id) => Math.max(max, rankOf(id)), 0) + band;
  });

  const totalRank = rank - band;
  const width = rankVertical ? totalCross : totalRank;
  const height = rankVertical ? totalRank : totalCross;
  if (width < 1 || height < 1 || width > opts.width || height > opts.maxRows) return null;

  const cv = new Canvas(width, height);
  for (const b of boxes.values()) cv.box(b.rect, b.lines, b.node.shape);

  const notes: string[] = [];
  const dropped = { labels: 0 };
  const ctx: RouteCtx = { rankVertical, flip, crossMax: totalCross - 1, dropped };
  let drawn = 0;
  for (const e of graph.edges) {
    if (back.has(e)) continue;
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) continue;
    if (routeEdge(cv, a, b, e, ctx)) drawn++;
    else notes.push(`edge not drawn: ${a.node.label} → ${b.node.label}`);
  }
  if (dropped.labels > 0) notes.push(`${dropped.labels} edge label(s) omitted (no room)`);
  for (const e of back) {
    const fromId = flip ? e.to : e.from;
    const toId = flip ? e.from : e.to;
    notes.push(`${charset.loop} cycle edge: ${byId.get(fromId)?.label ?? fromId} → ${byId.get(toId)?.label ?? toId}`);
  }

  return finalize(cv, {
    mode: "layered",
    direction: g.direction,
    nodes: boxes.size,
    edges: drawn,
    notes: [...g.notes, ...notes],
  });
}

/** Shared context for routing one layered-layout edge (keeps params few). */
interface RouteCtx {
  rankVertical: boolean;
  /** True for BT/RL: the arrowhead belongs on the upstream box. */
  flip: boolean;
  /** Last drawable cross coordinate (gutter edge) for detour channels. */
  crossMax: number;
  dropped: { labels: number };
}

/**
 * Candidate paths for `a → b`, best-looking first: straight shared channel,
 * elbows next to either box, then Z routes through any column (including the
 * side gutters, so long edges detour instead of disappearing).
 */
function edgePaths(a: Box, b: Box, from: Pt, to: Pt, crossMax: number): Pt[][] {
  const candidates: Pt[][] = [];

  // 1. Straight channel: a column (TD) / row (LR) that touches both boxes,
  //    so the edge never has to jog. Nearest the target center first — when
  //    several edges enter the same box they take neighbouring ports instead
  //    of fighting over one cell.
  const lo = Math.max(a.cross0, b.cross0), hi = Math.min(a.cross1, b.cross1) - 1;
  if (lo <= hi) {
    const ports: number[] = [];
    for (let c = lo; c <= hi; c++) ports.push(c);
    ports.sort((p, q) => Math.abs(p - to.c) - Math.abs(q - to.c));
    for (const c of ports.slice(0, 6)) candidates.push([{ r: from.r, c }, { r: to.r, c }]);
  }
  if (from.c === to.c) candidates.push([from, to]);

  // 2. Elbow just above the target, then 3. just below the source.
  candidates.push([from, { r: to.r, c: from.c }, to]);
  candidates.push([from, { r: from.r, c: to.c }, to]);

  // 4. Z route through a channel column, nearest the target first.
  const columns: number[] = [];
  for (let c = 0; c <= crossMax; c++) if (c !== from.c && c !== to.c) columns.push(c);
  columns.sort((p, q) => Math.abs(p - to.c) - Math.abs(q - to.c));
  for (const c of columns.slice(0, 40)) candidates.push([from, { r: from.r, c }, { r: to.r, c }, to]);
  return candidates;
}

/**
 * Route one edge. `a` is the upstream box in layout space; `flip` means the
 * real arrow points upstream, so the arrowhead goes at `a` instead of `b`.
 *
 * Candidate paths are tried clean-first (nothing else drawn on them), then
 * again allowing merges, so a busy diagram still shows every edge instead of
 * silently dropping it.
 */
function routeEdge(cv: Canvas, a: Box, b: Box, edge: FlowEdge, ctx: RouteCtx): boolean {
  const { rankVertical, flip, crossMax, dropped } = ctx;
  const from: Pt = { r: a.rank1 + 1, c: a.crossMid };
  const to: Pt = { r: b.rank0 - 1, c: b.crossMid };
  if (to.r < from.r) return false;
  const headAtB = !flip;
  const dir: "up" | "right" | "down" | "left" = rankVertical
    ? (headAtB ? "down" : "up")
    : (headAtB ? "right" : "left");

  const candidates = edgePaths(a, b, from, to, crossMax);
  for (const allowShared of [false, true]) {
    for (const path of candidates) {
      if (!pathClear(cv, path, rankVertical, allowShared)) continue;
      for (let i = 0; i + 1 < path.length; i++) drawAlong(cv, path[i], path[i + 1], edge.style, rankVertical);
      const head = toXY(headAtB ? path[path.length - 1] : path[0], rankVertical);
      cv.arrow(head.x, head.y, dir);
      placeLabel(cv, path, edge.label, rankVertical, dropped);
      return true;
    }
  }
  return false;
}

/** Every segment of a candidate path is drawable. */
function pathClear(cv: Canvas, path: Pt[], rankVertical: boolean, allowShared: boolean): boolean {
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i], q = path[i + 1];
    if (p.c === q.c) {
      if (!cv.freeRank(p.c, p.r, q.r, rankVertical, allowShared)) return false;
    } else if (p.r === q.r) {
      if (!cv.freeCross(p.r, p.c, q.c, rankVertical, allowShared)) return false;
    } else {
      return false; // not axis-aligned
    }
  }
  return true;
}

/** Draw one axis-aligned abstract segment (rank or cross direction). */
function drawAlong(cv: Canvas, p: Pt, q: Pt, style: EdgeStyle, rankVertical: boolean): void {
  const A = toXY(p, rankVertical);
  const B = toXY(q, rankVertical);
  if (A.x === B.x) cv.vLine(A.x, A.y, B.y, style);
  else cv.hLine(A.y, A.x, B.x, style);
}

/**
 * Edge labels: prefer the longest horizontal run (the label sits on the line,
 * like mermaid does); otherwise put it beside the longest vertical run, in the
 * routing band that is free by construction. `dropped` counts labels that had
 * no room, so the caller can say so instead of losing them silently.
 */
function placeLabel(
  cv: Canvas, path: Pt[], label: string, rankVertical: boolean, dropped: { labels: number },
): void {
  if (!label) return;
  const runs: Array<{ p: Pt; q: Pt; len: number; horizontal: boolean }> = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i], q = path[i + 1];
    const A = toXY(p, rankVertical), B = toXY(q, rankVertical);
    const horizontal = A.y === B.y;
    const len = horizontal ? Math.abs(B.x - A.x) + 1 : Math.abs(B.y - A.y) + 1;
    runs.push({ p, q, len, horizontal });
  }
  const byLen = (a: { len: number }, b: { len: number }) => b.len - a.len;
  const labelW = measure(label);
  const ordered = runs.slice().sort(byLen);

  // Longest suitable run wins: the text stays away from the box the edge just
  // left. Horizontal runs carry the label on the line, vertical runs carry it
  // beside the line (mermaid's own convention).
  const onLine = ordered.find((r) => r.horizontal && r.len >= labelW + 2);
  if (onLine) {
    const A = toXY(onLine.p, rankVertical), B = toXY(onLine.q, rankVertical);
    const [x1, x2] = A.x <= B.x ? [A.x, B.x] : [B.x, A.x];
    cv.text(x1 + Math.floor((x2 - x1 + 1 - labelW) / 2), A.y, label, "elabel", true);
    return;
  }

  const beside = ordered.find((r) => !r.horizontal);
  if (beside) {
    const A = toXY(beside.p, rankVertical), B = toXY(beside.q, rankVertical);
    const midY = A.y + Math.floor((B.y - A.y) / 2);
    if (cv.freeH(midY, A.x + 1, A.x + labelW)) cv.text(A.x + 1, midY, label, "elabel");
    else if (cv.freeH(midY, A.x - labelW, A.x - 1)) cv.text(A.x - labelW, midY, label, "elabel");
    else dropped.labels++;
    return;
  }
  dropped.labels++;
}

// ── 7. Strip layout (long chains) ───────────────────────────────────────────

/**
 * Flow the topological order into wrapped rows of boxes. Chosen when layered
 * placement cannot fit: a 20-node version timeline becomes 3 rows of boxes
 * instead of 20 rows of boxes.
 */
function stripLayout(g: FlowGraph, opts: LayoutOpts): Raster | null {
  const { layers, back } = rankLayers(g);
  if (layers.length === 0) return null;
  const sizes = sizeBoxes(g, opts.cap, 3);
  const order: string[] = [];
  for (const L of layers) order.push(...L);

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const next = new Map<string, { id: string; style: EdgeStyle; label: string }>();
  for (const e of g.edges) {
    if (back.has(e)) continue;
    if (!next.has(e.from)) next.set(e.from, { id: e.to, style: e.style, label: e.label });
  }

  interface Placed { id: string; row: number; rect: Rect; lines: string[]; shape: NodeShape }
  const rows: Placed[][] = [];
  let current: Placed[] = [];
  let x = 0;
  for (const id of order) {
    const size = sizes.get(id)!;
    const prev = current[current.length - 1];
    const linked = prev !== undefined && next.get(prev.id)?.id === id;
    const gap = linked ? STRIP_GAP : GAP;
    if (current.length > 0 && x + gap + size.w > opts.width) {
      rows.push(current);
      current = [];
      x = 0;
    }
    current.push({
      id, row: rows.length, lines: size.lines, shape: byId.get(id)!.shape,
      rect: { x, y: 0, w: size.w, h: size.h },
    });
    x += gap + size.w;
  }
  if (current.length > 0) rows.push(current);

  // Stack rows, vertically centering each box inside its row band.
  let y = 0;
  for (const row of rows) {
    const h = row.reduce((max, p) => Math.max(max, p.rect.h), 0);
    for (const p of row) p.rect.y = y + Math.floor((h - p.rect.h) / 2);
    y += h + STRIP_BAND;
  }
  const height = y - STRIP_BAND;
  const width = rows.reduce((max, row) => {
    const last = row[row.length - 1];
    return Math.max(max, last ? last.rect.x + last.rect.w : 0);
  }, 0);
  if (width < 1 || height < 1 || width > opts.width || height > opts.maxRows) return null;

  const cv = new Canvas(width, height);
  const placed = new Map<string, Placed>();
  for (const row of rows) for (const p of row) {
    placed.set(p.id, p);
    cv.box(p.rect, p.lines, p.shape);
  }

  const notes: string[] = [];
  let drawn = 0;
  let labelsDropped = 0;
  for (let i = 0; i + 1 < order.length; i++) {
    const a = placed.get(order[i]);
    const b = placed.get(order[i + 1]);
    const link = next.get(order[i]);
    if (!a || !b || !link || link.id !== order[i + 1]) continue;
    if (a.row === b.row) {
      // Same row: `──▶` across the gap, on the line joining the two box middles.
      const midY = Math.floor(
        (a.rect.y + Math.floor(a.rect.h / 2) + b.rect.y + Math.floor(b.rect.h / 2)) / 2,
      );
      const from = a.rect.x + a.rect.w;
      const to = b.rect.x - 1;
      cv.hLine(midY, from, to - 1, link.style);
      cv.arrow(to, midY, "right");
      if (link.label === "" || to - from >= measure(link.label) + 2) {
        const start = from + Math.floor((to - from - measure(link.label)) / 2);
        cv.text(start, midY - 1, link.label, "elabel");
      } else labelsDropped++;
      drawn++;
      continue;
    }
    // Wrapped to the next row: down out of `a`, across the band, down into `b`.
    const sx = a.rect.x + Math.floor(a.rect.w / 2);
    const tx = b.rect.x + Math.floor(b.rect.w / 2);
    const headY = Math.max(a.rect.y + a.rect.h, b.rect.y - 1);
    const runY = Math.max(a.rect.y + a.rect.h, headY - 1);
    cv.line(sx, runY, UP | LEFT, link.style);
    cv.hLine(runY, tx + 1, sx - 1, link.style);
    cv.line(tx, runY, DOWN | RIGHT, link.style);
    cv.arrow(tx, headY, "down");
    drawn++;
  }
  if (labelsDropped > 0) notes.push(`${labelsDropped} edge label(s) omitted (no room)`);
  for (const e of g.edges) if (back.has(e)) {
    notes.push(`${charset.loop} cycle edge: ${byId.get(e.from)?.label ?? e.from} → ${byId.get(e.to)?.label ?? e.to}`);
  }
  const skipped = g.edges.length - back.size - drawn;
  if (skipped > 0) notes.push(`${skipped} side edge(s) not drawn (chain order only)`);

  // Chain layout only tells the truth about chain-shaped graphs: it draws an
  // edge only between consecutive nodes in topological order. A branching
  // graph (fan-out/fan-in) would lose most of its connectors and read as a
  // grid of disconnected boxes — worse than the honest summary, so refuse.
  const nonBack = g.edges.length - back.size;
  if (drawn * 2 < nonBack) return null;

  return finalize(cv, {
    mode: "strip",
    direction: "chain",
    nodes: placed.size,
    edges: drawn,
    notes: [...g.notes, ...notes],
  });
}

// ── 8. Entry point ──────────────────────────────────────────────────────────

const cache = new Map<string, Raster | null>();
const CACHE_MAX = 24;

/**
 * Layered placement over every (cap, band) candidate, widest cap first.
 * The band tightens 3 → 2 → 1 before the cap narrows: for TD graphs it is
 * height, not width, that overflows the budget, and a 1-row band still
 * routes every edge (straight drops and shared horizontal runs) — it just
 * cannot jog around boxes.
 */
function layeredFits(graph: FlowGraph, width: number, maxRows: number): Raster | null {
  for (const cap of LAYERED_CAPS) {
    for (const band of [BAND, 2, 1]) {
      const raster = layeredLayout(graph, { width, maxRows, cap, band });
      if (raster) return raster;
    }
  }
  return null;
}

/**
 * Render a mermaid flowchart into a raster, or null when the source is not a
 * flowchart, is too large, or cannot fit the pane. Cached per source+width so
 * the row estimator and the renderer share one layout pass.
 */
export function renderFlowchart(lines: string[], width: number, maxRows = 40): Raster | null {
  const key = `${width}x${maxRows}\u0000${lines.join("\n")}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let result: Raster | null = null;
  try {
    const graph = parseFlowchart(lines);
    if (graph) {
      result = layeredFits(graph, width, maxRows);
      if (!result) {
        for (const cap of STRIP_CAPS) {
          result = stripLayout(graph, { width, maxRows, cap });
          if (result) break;
        }
      }
    }
  } catch {
    result = null; // caller falls back to the summary box
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, result);
  return result;
}
