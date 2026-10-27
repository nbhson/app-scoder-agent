/**
 * Minimal unified-diff generator (LCS-based, zero dependencies).
 * Large inputs fall back to a summary (truncated: true).
 */

export interface DiffResult {
  text: string;
  added: number;
  removed: number;
  /** True when the diff was too large to render fully */
  truncated: boolean;
}

const MAX_DIFF_LINES = 2000; // per side; beyond this, summarize only
const MAX_DIFF_TEXT_LINES = 120; // cap rendered diff lines

type Op = { type: " " | "-" | "+"; line: string };

/** LCS-based line diff producing ops in order. */
function computeOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", line: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "-", line: a[i] });
      i++;
    } else {
      ops.push({ type: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: "-", line: a[i] }); i++; }
  while (j < m) { ops.push({ type: "+", line: b[j] }); j++; }
  return ops;
}

function splitLines(content: string): string[] {
  const lines = content.split("\n");
  // Drop the artificial trailing empty element caused by a final newline
  if (lines.length > 0 && content.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * Unified diff between old and new file content.
 * oldContent === null means the file is new (all additions).
 */
export function unifiedDiff(
  path: string,
  oldContent: string | null,
  newContent: string,
): DiffResult {
  if (oldContent === newContent) {
    return { text: "", added: 0, removed: 0, truncated: false };
  }

  const a = oldContent === null ? [] : oldContent.split("\n");
  const b = newContent.split("\n");

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { text: "", added: b.length, removed: a.length, truncated: true };
  }

  const ops = computeOps(a, b);
  const added = ops.filter((o) => o.type === "+").length;
  const removed = ops.filter((o) => o.type === "-").length;

  if (added === 0 && removed === 0) return { text: "", added: 0, removed: 0, truncated: false };

  const header = `--- a/${path}\n+++ b/${path}\n`;
  const hunks = buildHunks(ops, 3);

  let text = header + hunks.join("\n");
  let truncated = false;
  const textLines = text.split("\n");
  if (textLines.length > MAX_DIFF_TEXT_LINES) {
    // Cap rendered diff lines; report counts instead of the full diff
    const kept = textLines.slice(0, MAX_DIFF_TEXT_LINES).join("\n");
    text = `${kept}\n... [diff truncated: +${added} -${removed} lines total]`;
    truncated = true;
  }

  return { text, added, removed, truncated };
}

/** Build unified-diff hunks with `context` lines of context around changes. */
function buildHunks(ops: Op[], context: number): string[] {
  // Indices of changed ops
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== " ") changed.push(i);
  }
  if (changed.length === 0) return [];

  // Prefix counts: lines in old/new file before op index i
  const prefixA = new Int32Array(ops.length + 1); // counts "-" and " "
  const prefixB = new Int32Array(ops.length + 1); // counts "+" and " "
  for (let i = 0; i < ops.length; i++) {
    prefixA[i + 1] = prefixA[i] + (ops[i].type === "+" ? 0 : 1);
    prefixB[i + 1] = prefixB[i] + (ops[i].type === "-" ? 0 : 1);
  }

  // Group change indices into hunks (merge when gap <= 2*context)
  const groups: Array<[number, number]> = [];
  let gs = changed[0];
  let prev = changed[0];
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - prev > context * 2) {
      groups.push([gs, prev]);
      gs = changed[k];
    }
    prev = changed[k];
  }
  groups.push([gs, prev]);

  const hunks: string[] = [];
  for (const [gStart, gEnd] of groups) {
    const start = Math.max(0, gStart - context);
    const end = Math.min(ops.length - 1, gEnd + context);

    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let k = start; k <= end; k++) {
      const op = ops[k];
      body.push(op.type + op.line);
      if (op.type === "-") aCount++;
      else if (op.type === "+") bCount++;
      else { aCount++; bCount++; }
    }

    // 1-based start lines; for empty side use the "line before" convention
    const aStart = aCount > 0 ? prefixA[start] + 1 : prefixA[start];
    const bStart = bCount > 0 ? prefixB[start] + 1 : prefixB[start];

    const header = `@@ -${aStart},${aCount} +${bStart},${bCount} @@`;
    hunks.push(header + "\n" + body.join("\n"));
  }
  return hunks;
}

/** Count added/removed lines for a summary like "+12 -3". */
export function diffCounts(
  oldContent: string | null,
  newContent: string,
): { added: number; removed: number } {
  if (oldContent === newContent) return { added: 0, removed: 0 };
  const a = (oldContent ?? "").split("\n");
  const b = newContent.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { added: b.length, removed: a.length };
  }
  const ops = computeOps(a, b);
  return {
    added: ops.filter((o) => o.type === "+").length,
    removed: ops.filter((o) => o.type === "-").length,
  };
}
