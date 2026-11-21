/**
 * Word-level diff (A4) — pure pre-pass over unified-diff text.
 *
 * Git `--word-diff` UX in the terminal: when a removed run is immediately
 * followed by an added run of the same length, pair the lines 1:1 and split
 * each pair into common-prefix / changed-middle / common-suffix token
 * segments, so the viewer can paint ONLY the changed words with a
 * background, instead of shouting at every character of a 100-column line.
 *
 * Tokenization is lossless: the token regex keeps whitespace and punctuation
 * as their own tokens, and joining a line's tokens reproduces the line text.
 * Unpaired / context / header lines pass through verbatim.
 */

export type DiffOp = "eq" | "del" | "ins";

export interface Seg {
  text: string;
  op: DiffOp;
}

export type WLine =
  | { kind: "raw"; text: string }
  | { kind: "del" | "add"; prefix: string; segs: Seg[] };

const isMinus = (l: string): boolean => l.startsWith("-") && !l.startsWith("---");
const isPlus = (l: string): boolean => l.startsWith("+") && !l.startsWith("+++");

/** Lossless tokenization: words, punctuation runs, whitespace runs. */
function tokenize(line: string): string[] {
  return line.match(/\w+|[^\w\s]|\s+/g) ?? [];
}

/** Common prefix/suffix token diff of one paired line (git word-diff core). */
function pairSegments(delText: string, addText: string): { del: Seg[]; add: Seg[] } {
  const a = tokenize(delText);
  const b = tokenize(addText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const mid = (t: string[], op: DiffOp, lo: number, hi: number): Seg[] => {
    const out: Seg[] = [];
    if (lo > 0) out.push({ text: t.slice(0, lo).join(""), op: "eq" });
    const m = t.slice(lo, t.length - hi).join("");
    if (m) out.push({ text: m, op });
    if (hi > 0) out.push({ text: t.slice(t.length - hi).join(""), op: "eq" });
    return out;
  };
  return {
    del: mid(a, "del", p, s),
    add: mid(b, "ins", p, s),
  };
}

/** Unified diff text → render-ready lines with word segments on pairs. */
export function wordDiff(diffText: string): WLine[] {
  const lines = diffText.length > 0 ? diffText.split("\n") : [];
  const out: WLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isMinus(lines[i])) {
      out.push({ kind: "raw", text: lines[i] });
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && isMinus(lines[j])) j++;
    let k = j;
    while (k < lines.length && isPlus(lines[k])) k++;
    const delRun = lines.slice(i, j);
    const addRun = lines.slice(j, k);
    const pairs = Math.min(delRun.length, addRun.length);
    const segs = Array.from({ length: pairs }, (_, p) => pairSegments(delRun[p].slice(1), addRun[p].slice(1)));
    // Emit in unified-diff order: all minus lines, then all plus lines.
    for (let p = 0; p < delRun.length; p++) {
      out.push(p < pairs ? { kind: "del", prefix: "-", segs: segs[p].del } : { kind: "del", prefix: "-", segs: [{ text: delRun[p].slice(1), op: "del" }] });
    }
    for (let p = 0; p < addRun.length; p++) {
      out.push(p < pairs ? { kind: "add", prefix: "+", segs: segs[p].add } : { kind: "add", prefix: "+", segs: [{ text: addRun[p].slice(1), op: "ins" }] });
    }
    i = k;
  }
  return out;
}

/** Lossless check helper: joining a WLine back must reproduce the raw line. */
export function wlineText(l: WLine): string {
  return l.kind === "raw" ? l.text : l.prefix + l.segs.map((s) => s.text).join("");
}
