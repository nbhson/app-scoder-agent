/**
 * Lightweight markdown renderer for the TUI chat pane — no external deps.
 *
 * Supported:
 * - Fenced code blocks with syntax highlighting + line numbers
 * - Mermaid diagram blocks (```mermaid) → ASCII-art visual preview
 * - # Headers (bold, magenta/cyan)
 * - GFM tables with proper unicode borders
 * - - Bullets (cyan bullet) + task lists: - [ ] / - [x]
 * - Numbered lists
 * - > Quotes (dim, left bar)
 * - Inline `code` / **bold** / [link](url)
 *
 * Long lines are hard-wrapped at MAX_LINE so Ink never overflows the pane.
 */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

const MAX_LINE = 160;
const MAX_CODE_LINES = 60;

function clip(line: string): string {
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE - 1) + "…" : line;
}

// ── Syntax highlighting ───────────────────────────────────────────────────────

/** T-15: token-based syntax highlighter for TypeScript/JavaScript/JSON/shell. */
function highlightCode(code: string[]): React.ReactNode[] {
  const kw = new Set(["const", "let", "var", "function", "async", "await", "return",
    "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
    "try", "catch", "finally", "throw", "class", "extends", "import", "export",
    "from", "default", "new", "typeof", "instanceof", "void", "in", "of",
    "interface", "type", "enum", "implements", "private", "public", "protected",
    "readonly", "abstract", "override", "declare", "namespace", "module"]);
  const typeKw = new Set(["string", "number", "boolean", "any", "unknown", "never",
    "null", "undefined", "void", "object", "true", "false", "Promise", "Array",
    "Record", "Partial", "Required", "Omit", "Pick", "keyof", "infer"]);

  return code.slice(0, MAX_CODE_LINES).map((line, i) => {
    const parts: React.ReactNode[] = [];
    const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(\b0x[\da-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?\b)|(\w+)/g;
    let last = 0;
    let k = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      const tok = m[0];
      if (m[1]) parts.push(<Text key={`c${i}-${k++}`} color={theme.code}>{tok}</Text>);
      else if (m[2]) parts.push(<Text key={`c${i}-${k++}`} color={theme.thinking}>{tok}</Text>);
      else if (m[3]) parts.push(<Text key={`c${i}-${k++}`} color="magenta">{tok}</Text>);
      else if (kw.has(tok)) parts.push(<Text key={`c${i}-${k++}`} bold color="cyan">{tok}</Text>);
      else if (typeKw.has(tok)) parts.push(<Text key={`c${i}-${k++}`} color="yellow">{tok}</Text>);
      else parts.push(line.slice(m.index, m.index + tok.length));
      last = m.index + tok.length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return (
      <Text key={i}>
        <Text dimColor>{String(i + 1).padStart(3, " ")} │ </Text>
        {parts.length > 0 ? parts : line}
      </Text>
    );
  });
}

// ── Mermaid ASCII preview ──────────────────────────────────────────────────────

/** T-15: parse mermaid source → compact ASCII art preview. */
function mermaidPreview(code: string[]): React.ReactNode {
  const text = code.join("\n").trim();
  const isFlowchart = /^(graph|flowchart|stateDiagram|erDiagram|gitGraph)/m.test(text);
  const isSequence = /^sequenceDiagram/m.test(text);

  const result: string[] = [];
  result.push("┌─ ◉ diagram preview ──────────────────────────────────┐");

  if (isFlowchart) {
    const nodeMap = new Map<string, string>();
    const edges: Array<[string, string, string]> = [];
    const nodeRe = /([A-Z][A-Za-z0-9_]*)(\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|\(\([^)]*\)\))/g;
    let m;
    while ((m = nodeRe.exec(text)) !== null) {
      nodeMap.set(m[1], m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[1]);
    }
    const edgeRe = /([A-Z][A-Za-z0-9_]*)\s*(-->?|-.->|==>|<-->|===>|---)\|?([^|]+)\|?\s*([A-Z][A-Za-z0-9_]*)/g;
    while ((m = edgeRe.exec(text)) !== null) {
      edges.push([m[1], "", m[4]]);
    }
    const nodes = [...nodeMap.entries()].slice(0, 6);
    for (const [id, label] of nodes) {
      result.push(`│  [${id}]  ${label.slice(0, 24).padEnd(24)}            │`);
    }
    if (nodes.length > 0) result.push("│  ─────────────────────────────────               │");
    for (const [from, , to] of edges.slice(0, 4)) {
      const fl = nodeMap.get(from) ?? from;
      const tl = nodeMap.get(to) ?? to;
      result.push(`│  ${fl.slice(0, 8)}  →  ${tl.slice(0, 8).padEnd(8)}              │`);
    }
  } else if (isSequence) {
    const parts: string[] = [];
    const partRe = /(?:participant|actor)\s+(\w+)/gi;
    let m;
    while ((m = partRe.exec(text)) !== null) parts.push(m[1]);
    if (parts.length > 0) result.push(`│  participants: ${parts.slice(0, 5).join(", ")}               │`);
    result.push("│  ─────────────────────────────────               │");
    const msgRe = /([\w]+)\s+(?:->|-->|-.>|=>)\s+([\w]+)(?:\s*:\s*(.*))?/gi;
    while ((m = msgRe.exec(text)) !== null) {
      if (result.length >= 10) { result.push("│  … (more messages)                              │"); break; }
      const from = (m[1] ?? "").slice(0, 8), to = (m[2] ?? "").slice(0, 8), msg = (m[3] ?? "").slice(0, 20);
      result.push(`│  ${from} → ${to.padEnd(8)} : ${msg}          │`);
    }
  } else {
    result.push("│  ◈ mermaid diagram                                  │");
    result.push("│  (run: npx @mermaid-js/mermaid-cli -i <file>)     │");
  }

  result.push("└─────────────────────────────────────────────────────┘");

  return (
    <Box flexDirection="column" marginTop={1}>
      {result.map((l, i) => (
        <Text key={i} color={theme.mermaid}>
          {i === 0 || i === result.length - 1 ? <Text bold>{l}</Text> : l}
        </Text>
      ))}
    </Box>
  );
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
      parts.push(<Text key={`${keyPrefix}-c${k++}`} color={theme.code}>{tok.slice(1, -1)}</Text>);
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
      const lang = line.slice(3).trim().toLowerCase();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++; // consume closing fence (or EOF)

      // T-15: mermaid diagram → visual ASCII preview
      if (lang === "mermaid" && code.length > 0) {
        blocks.push(
          <Box key={key++} marginTop={1}>
            <Text dimColor>  ◉ mermaid diagram</Text>
            {mermaidPreview(code)}
          </Box>,
        );
        continue;
      }

      // T-15: syntax-highlighted code block
      blocks.push(
        <Box key={key++} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>
          {lang && <Text dimColor bold>{lang}</Text>}
          {code.length === 0 ? (
            <Text dimColor>(empty)</Text>
          ) : (
            highlightCode(code)
          )}
          {code.length > MAX_CODE_LINES && (
            <Text dimColor>  … +{code.length - MAX_CODE_LINES} more lines</Text>
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

    // Bullets + task lists: - [ ] pending · - [x] completed
    const b = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (b) {
      const body = b[2];
      const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(body);
      const indent = "  ".repeat(Math.floor(b[1].length / 2));
      if (taskMatch) {
        const checked = taskMatch[1].toLowerCase() === "x";
        const taskBody = taskMatch[2];
        blocks.push(
          <Text key={key++}>
            <Text color={theme.accent}>{indent}{checked ? "☑" : "☐"} </Text>
            {checked
              ? <Text dimColor strikethrough>{renderInline(taskBody, `b${key}`)}</Text>
              : renderInline(taskBody, `b${key}`)
            }
          </Text>,
        );
      } else {
        blocks.push(
          <Text key={key++}>
            <Text color={theme.accent}>{indent}• </Text>
            {renderInline(body, `b${key}`)}
          </Text>,
        );
      }
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
          <Text color={theme.dim}>│</Text> <Text italic>{clip(line.replace(/^>\s?/, ""))}</Text>
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
