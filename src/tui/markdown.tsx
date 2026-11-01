/**
 * Lightweight markdown renderer for the TUI chat pane — no external deps.
 *
 * Supported (line-based): fenced code blocks (``` with dim round border),
 * # headers (bold, magenta/cyan), - bullets (cyan •), numbered lists,
 * > quotes (dim, left bar), and inline `code` / **bold** / [link](url).
 * Long lines are hard-wrapped at MAX_LINE so Ink never overflows the pane.
 */
import React from "react";
import { Box, Text } from "ink";

const MAX_LINE = 180;

function clip(line: string): string {
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line;
}

/** Render inline markdown tokens as nested Ink <Text> elements. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\n]+\))/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      parts.push(<Text key={`${keyPrefix}-c${k++}`} color="green">{tok.slice(1, -1)}</Text>);
    } else if (tok.startsWith("**")) {
      parts.push(<Text key={`${keyPrefix}-b${k++}`} bold>{tok.slice(2, -2)}</Text>);
    } else {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      if (lm) {
        parts.push(
          <Text key={`${keyPrefix}-l${k++}`}>
            <Text color="blue">{lm[1]}</Text>
            <Text dimColor> ({lm[2]})</Text>
          </Text>,
        );
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const lines = text.split("\n");
  const blocks: React.JSX.Element[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++; // consume closing fence (or EOF)
      blocks.push(
        <Box key={key++} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
          {lang && <Text dimColor>{lang}</Text>}
          {code.length === 0 ? (
            <Text dimColor>(empty)</Text>
          ) : (
            code.map((c, j) => <Text key={j}>{clip(c)}</Text>)
          )}
        </Box>,
      );
      continue;
    }

    // Headers
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <Text key={key++} bold color={h[1].length <= 2 ? "magenta" : "cyan"}>
          {renderInline(h[2], `h${key}`)}
        </Text>,
      );
      i++;
      continue;
    }

    // Table (GFM): header | separator | rows — collect the whole block.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const MAX_CELL = 40;
      const parseRow = (l: string) =>
        l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const header = parseRow(line);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(parseRow(lines[i++]));
      // Column widths (bounded — wide cells clip via clip()).
      const widths = header.map((h, c) =>
        Math.min(MAX_CELL, Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length))),
      );
      const renderRow = (cells: string[], chars: { l: string; m: string; r: string }, color?: string, bold?: boolean, rowKey?: string) => {
        const line =
          chars.l + cells.map((c, ci) => (c.length > widths[ci] ? c.slice(0, widths[ci] - 1) + "…" : c).padEnd(widths[ci], " ")).join(chars.m) + chars.r;
        return <Text key={rowKey} color={color} bold={bold}>{clip(line)}</Text>;
      };
      blocks.push(
        <Box key={key++} flexDirection="column" marginTop={1}>
          {renderRow(header, { l: "┌ ", m: " ┬ ", r: " ┐" }, undefined, true, `th${key}`)}
          {renderRow(header.map(() => ""), { l: "├", m: "┼", r: "┤" }, "gray", false, `ts${key}`)}
          {rows.map((r, ri) => renderRow(r, { l: "│ ", m: " │ ", r: " │" }, undefined, false, `tr${key}-${ri}`))}
        </Box>,
      );
      continue;
    }

    // Bullets
    const b = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (b) {
      blocks.push(
        <Text key={key++}>
          <Text color="cyan">{"  ".repeat(Math.floor(b[1].length / 2))}• </Text>
          {renderInline(b[2], `b${key}`)}
        </Text>,
      );
      i++;
      continue;
    }

    // Numbered list — keep the numbering as-is; nested indent preserved.
    const n = /^(\s*)(\d+\.)\s+(.*)$/.exec(line);
    if (n) {
      const indent = "  ".repeat(Math.floor(n[1].length / 2));
      blocks.push(
        <Text key={key++}>
          <Text color="cyan">{indent}</Text>
          {renderInline(`${n[2]} ${n[3]}`, `n${key}`)}
        </Text>,
      );
      i++;
      continue;
    }

    // Quote
    if (/^>\s?/.test(line)) {
      blocks.push(
        <Text key={key++} dimColor>
          │ {clip(line.replace(/^>\s?/, ""))}
        </Text>,
      );
      i++;
      continue;
    }

    // Blank line → single spacer
    if (line.trim() === "") {
      blocks.push(<Text key={key++}> </Text>);
      i++;
      continue;
    }

    blocks.push(<Text key={key++}>{renderInline(clip(line), `t${key}`)}</Text>);
    i++;
  }

  return <Box flexDirection="column">{blocks}</Box>;
}
