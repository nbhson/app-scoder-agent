/**
 * GFM table renderer — full unicode borders, alignment row support, cell
 * wrapping, Unicode/emoji-safe widths (text-width.ts), graceful degrade to a
 * key-value layout when the pane is too narrow, row cap for huge tables.
 */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { charset } from "../charset.js";
import { clipCells, measure, padEndCells, padStartCells, wrapCells } from "../text-width.js";
import type { TableAlign } from "./ast.js";
import { inlineToPlain } from "./inline.js";
import { renderInline } from "./inline-render.js";

const MAX_CELL = 40;
const MIN_CELL = 4;
const MAX_ROWS = 50;
/** Below this pane width (or when columns can't fit even at MIN_CELL), degrade. */
const MIN_TABLE_WIDTH = 28;

interface TableSpec {
  header: string[];
  align: TableAlign[];
  rows: string[][];
}

/** Pad a plain-text cell per alignment; returns text of exactly `width` cells. */
function alignCell(plain: string, width: number, align: TableAlign): string {
  const clipped = clipCells(plain, width);
  const missing = width - measure(clipped);
  if (missing <= 0) return clipped;
  if (align === "right") return padStartCells(clipped, width);
  if (align === "center") {
    const left = Math.floor(missing / 2);
    return " ".repeat(left) + clipped + " ".repeat(missing - left);
  }
  return padEndCells(clipped, width);
}

/** Column widths: natural content widths, proportionally shrunk to fit. */
function columnWidths(spec: TableSpec, cols: number, available: number): number[] | null {
  const natural: number[] = [];
  for (let c = 0; c < cols; c++) {
    const cells = [spec.header[c] ?? "", ...spec.rows.map((r) => r[c] ?? "")];
    natural.push(Math.min(MAX_CELL, Math.max(...cells.map((t) => measure(inlineToPlain(t))), 1)));
  }
  const overhead = cols * 2 + (cols + 1); // 2 padding cells + 1 border per column
  const totalNatural = natural.reduce((a, b) => a + b, 0);
  if (totalNatural + overhead <= available) return natural;
  const budget = available - overhead;
  if (cols * MIN_CELL > budget) return null; // cannot fit even minimal columns
  const shrunk = natural.map((n) => Math.max(MIN_CELL, Math.floor((n / totalNatural) * budget)));
  return shrunk;
}

/** One physical border line: ┌───┬───┐ / ├───┼───┤ / └───┴───┘ */
function borderLine(widths: number[], chars: { l: string; m: string; r: string; h: string }): string {
  return chars.l + widths.map((w) => chars.h.repeat(w + 2)).join(chars.m) + chars.r;
}

export function TableView({ header, align, rows, width }: TableSpec & { width: number }): React.JSX.Element {
  const cols = header.length;
  const available = Math.max(12, width - 2);
  const widths = columnWidths({ header, align, rows }, cols, available);

  // Degrade: pane too narrow / too many columns → key-value per row.
  if (widths === null || available < MIN_TABLE_WIDTH) {
    return <KeyValueTable header={header} rows={rows} width={width} />;
  }

  const alignOf = (c: number): TableAlign => align[c] ?? "left";
  const lines: React.JSX.Element[] = [];
  let k = 0;

  const vSep = `${charset.v} `;
  lines.push(<Text key={k++} color={theme.table}>{borderLine(widths, { l: charset.tl, m: charset.teeDown, r: charset.tr, h: charset.h })}</Text>);

  // Header row — cells may wrap; bold.
  const headerWrapped = header.map((h, c) => wrapCells(inlineToPlain(h), widths[c]));
  const headerHeight = Math.max(...headerWrapped.map((w) => w.length));
  for (let r = 0; r < headerHeight; r++) {
    lines.push(
      <Text key={k++} bold color={theme.table}>
        {`${charset.v} `}{header.map((_, c) => alignCell(headerWrapped[c][r] ?? "", widths[c], alignOf(c))).join(` ${charset.v} `)}{` ${charset.v}`}
      </Text>,
    );
  }

  lines.push(<Text key={k++} color={theme.table}>{borderLine(widths, { l: charset.teeRight, m: charset.cross, r: charset.teeLeft, h: charset.h })}</Text>);

  const shown = rows.slice(0, MAX_ROWS);
  for (const row of shown) {
    // Wrap each cell; row height = tallest cell.
    const wrapped = Array.from({ length: cols }, (_, c) => wrapCells(inlineToPlain(row[c] ?? ""), widths[c]));
    const height = Math.max(...wrapped.map((w) => w.length), 1);
    for (let r = 0; r < height; r++) {
      lines.push(
        <Text key={k++}>
          <Text color={theme.table}>{vSep}</Text>
          {Array.from({ length: cols }, (_, c) => {
            const plain = wrapped[c][r] ?? "";
            const missing = Math.max(0, widths[c] - measure(plain));
            const a = alignOf(c);
            const lead = a === "right" ? missing : a === "center" ? Math.floor(missing / 2) : 0;
            const trail = missing - lead;
            // First physical line of a single-line cell renders inline markdown;
            // wrapped/extra lines render plain (markers already stripped).
            const content = r === 0 && plain === inlineToPlain(row[c] ?? "")
              ? renderInline(row[c] ?? "", `t${k}-${c}`)
              : plain;
            return (
              <Text key={c}>
                {" ".repeat(lead)}{content}{" ".repeat(trail)}
              </Text>
            );
          }).flatMap((node, c) => (c === 0 ? [node] : [<Text key={`s${c}`} color={theme.table}>{` ${charset.v} `}</Text>, node]))}
          <Text color={theme.table}>{` ${charset.v}`}</Text>
        </Text>,
      );
    }
  }
  if (rows.length > MAX_ROWS) {
    lines.push(<Text key={k++} dimColor>{charset.v} {"… " + (rows.length - MAX_ROWS) + " more rows"}</Text>);
  }

  lines.push(<Text key={k++} color={theme.table}>{borderLine(widths, { l: charset.bl, m: charset.teeUp, r: charset.br, h: charset.h })}</Text>);

  return <Box flexDirection="column" marginTop={1}>{lines}</Box>;
}

/** Narrow-pane fallback: one labelled mini-record per row. */
function KeyValueTable({ header, rows, width }: { header: string[]; rows: string[][]; width: number }): React.JSX.Element {
  const labelWidth = Math.min(20, Math.max(...header.map((h) => measure(inlineToPlain(h))), 1));
  const valueWidth = Math.max(8, width - labelWidth - 5);
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.table} bold> table · {rows.length} row{rows.length === 1 ? "" : "s"} × {header.length} cols</Text>
      {shown.map((row, ri) => (
        <Box key={ri} flexDirection="column">
          {ri > 0 && <Text dimColor>{"  "}{charset.h.repeat(Math.min(20, width - 2))}</Text>}
          {header.map((h, c) => {
            const value = row[c] ?? "";
            if (value.trim() === "") return null;
            return (
              <Text key={c}>
                {"  "}
                <Text color={theme.table}>{padEndCells(clipCells(inlineToPlain(h), labelWidth), labelWidth)}</Text>
                {` ${charset.v} `}
                {renderInline(clipCells(inlineToPlain(value), valueWidth), `kv${ri}-${c}`)}
              </Text>
            );
          })}
        </Box>
      ))}
      {rows.length > MAX_ROWS && <Text dimColor>  … {rows.length - MAX_ROWS} more rows</Text>}
    </Box>
  );
}
