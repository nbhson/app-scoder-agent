/**
 * Markdown block parser — pure, sync, zero-dep. Converts raw assistant text
 * into the Block AST (ast.ts). Rendering lives in render.tsx / table.tsx /
 * diagram.tsx.
 *
 * Supported blocks: fenced code (unclosed fence tolerated), mermaid / chart /
 * timeline fences, GFM tables (escaped pipes + code spans + alignment row),
 * headings 1-6, bullet/task/numbered lists (nested by indent), quotes,
 * horizontal rules, paragraphs, spacers.
 *
 * Structure: an ordered chain of line-matchers — each matcher either returns
 * { block, next } (block(s) + index of the next unconsumed line) or null.
 * Adding a block type = adding a matcher; the main loop stays trivial.
 */
import type { Block, ListItem, TableAlign } from "./ast.js";
import { splitOutsideCodeSpans } from "./inline.js";

const TABLE_CELL_RX = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RX = /^\s*\|[\s:|-]+\|\s*$/;
const HR_RX = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/** Split one table row into cells: \| escapes and `code|spans` are safe. */
export function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return splitOutsideCodeSpans(trimmed, "|").map((c) => c.trim());
}

/** Parse the GFM separator row (`:---`, `:--:`, `--:`) into alignments. */
export function parseTableAlign(line: string): TableAlign[] {
  return parseTableRow(line).map((cell) => {
    const c = cell.replace(/\s/g, "");
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

interface Match {
  blocks: Block[];
  /** Index of the next unconsumed line. */
  next: number;
}

type Matcher = (lines: string[], i: number) => Match | null;

/** Fenced code block (```lang … ```) — EOF closes an unclosed fence. */
const matchFence: Matcher = (lines, i) => {
  if (!lines[i].startsWith("```")) return null;
  const lang = lines[i].slice(3).trim().toLowerCase();
  const code: string[] = [];
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith("```")) code.push(lines[j++]);
  j++; // consume closing fence (or EOF)

  let block: Block;
  if (lang === "mermaid" && code.length > 0) block = { kind: "mermaid", lines: code };
  else if ((lang === "chart" || lang.startsWith("chart:")) && code.length > 0) block = { kind: "chart", lang, source: code.join("\n") };
  else if ((lang === "timeline" || lang === "events") && code.length > 0) block = { kind: "timeline", source: code.join("\n") };
  else block = { kind: "code", lang, lines: code };
  return { blocks: [block], next: j };
};

const matchHeading: Matcher = (lines, i) => {
  const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
  if (!h) return null;
  return { blocks: [{ kind: "heading", level: h[1].length, text: h[2].trim() }], next: i + 1 };
};

const matchHr: Matcher = (lines, i) =>
  HR_RX.test(lines[i]) ? { blocks: [{ kind: "hr" }], next: i + 1 } : null;

/** GFM table: header row | separator row (with alignment) | body rows. */
const matchTable: Matcher = (lines, i) => {
  if (!TABLE_CELL_RX.test(lines[i])) return null;
  if (i + 1 >= lines.length || !TABLE_SEP_RX.test(lines[i + 1])) return null;
  const header = parseTableRow(lines[i]);
  const align = parseTableAlign(lines[i + 1]);
  let j = i + 2;
  const rows: string[][] = [];
  while (j < lines.length && TABLE_CELL_RX.test(lines[j])) rows.push(parseTableRow(lines[j++]));
  return { blocks: [{ kind: "table", header, align, rows }], next: j };
};

function parseListItem(line: string): ListItem | null {
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (bullet) {
    const depth = Math.floor(bullet[1].replace(/\t/g, "  ").length / 2);
    const body = bullet[2];
    const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
    if (task) {
      return { depth, marker: null, checked: task[1].toLowerCase() === "x", text: task[2] };
    }
    return { depth, marker: null, text: body };
  }
  const numbered = /^(\s*)(\d+\.)\s+(.*)$/.exec(line);
  if (numbered) {
    const depth = Math.floor(numbered[1].replace(/\t/g, "  ").length / 2);
    return { depth, marker: numbered[2], text: numbered[3] };
  }
  return null;
}

/** Consecutive list items (bullets, task lists, numbered) → one list block. */
const matchList: Matcher = (lines, i) => {
  if (!parseListItem(lines[i])) return null;
  const items: ListItem[] = [];
  let j = i;
  while (j < lines.length) {
    const item = parseListItem(lines[j]);
    if (!item) break;
    items.push(item);
    j++;
  }
  return { blocks: [{ kind: "list", items }], next: j };
};

/** Consecutive `>` lines → one quote block. */
const matchQuote: Matcher = (lines, i) => {
  if (!/^>\s?/.test(lines[i])) return null;
  const quoted: string[] = [];
  let j = i;
  while (j < lines.length && /^>\s?/.test(lines[j])) quoted.push(lines[j++].replace(/^>\s?/, ""));
  return { blocks: [{ kind: "quote", text: quoted.join("\n") }], next: j };
};

const MATCHERS: Matcher[] = [matchFence, matchHeading, matchHr, matchTable, matchList, matchQuote];

/** Parse markdown text into blocks. Never throws — unknown input → paragraph. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line → single spacer (collapsed).
    if (line.trim() === "") {
      if (blocks.length > 0 && blocks[blocks.length - 1].kind !== "spacer") {
        blocks.push({ kind: "spacer" });
      }
      i++;
      continue;
    }

    let matched: Match | null = null;
    for (const matcher of MATCHERS) {
      matched = matcher(lines, i);
      if (matched) break;
    }
    if (matched) {
      blocks.push(...matched.blocks);
      i = matched.next;
      continue;
    }

    blocks.push({ kind: "paragraph", text: line });
    i++;
  }

  return blocks;
}
