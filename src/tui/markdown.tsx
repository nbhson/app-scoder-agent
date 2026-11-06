/**
 * Lightweight markdown renderer for the TUI chat pane — no external deps.
 *
 * Supported:
 * - Fenced code blocks with syntax highlighting + line numbers
 * - Mermaid diagram blocks (```mermaid) → ASCII-art visual preview
 * - # Headers (bold, magenta/cyan)
 * - GFM tables with responsive unicode borders + alignment
 * - `chart` fences (bar/line/pie) rendered as terminal-native charts
 * - `timeline` fences rendered as an accessible vertical event rail
 * - - Bullets (cyan bullet) + task lists: - [ ] / - [x]
 * - Numbered lists
 * - > Quotes (dim, left bar)
 * - Inline `code` / **bold** / [link](url)
 *
 * Long lines are hard-wrapped to the measured pane width so Ink never overflows.
 */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

const DEFAULT_WIDTH = 100;
const MAX_CODE_LINES = 60;

function clip(line: string, width = DEFAULT_WIDTH): string {
  const safeWidth = Math.max(8, width);
  return line.length > safeWidth ? line.slice(0, safeWidth - 1) + "…" : line;
}

function contentWidth(width?: number): number {
  return Math.max(32, Math.floor(width ?? DEFAULT_WIDTH));
}

function scalar(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value.trim() : String(value);
}

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartSpec {
  type: "bar" | "line" | "pie";
  title?: string;
  data: ChartPoint[];
}

export interface TimelineEvent {
  time: string;
  title: string;
  detail?: string;
  status?: "done" | "active" | "pending" | "error";
}

/** Parse JSON or the intentionally small line format accepted by chart fences. */
export function parseChartSpec(source: string, language = "chart"): ChartSpec | null {
  const raw = source.trim();
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }

  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const typeRaw = scalar(object.type) || language.split(/[:\s]+/)[1] || "bar";
  const type = typeRaw.toLowerCase();
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(object.data) ? object.data : [];
  const data: ChartPoint[] = rows.flatMap((row, index) => {
    if (Array.isArray(row)) {
      const value = Number(row[1]);
      return Number.isFinite(value) ? [{ label: scalar(row[0]) || String(index + 1), value }] : [];
    }
    if (row && typeof row === "object") {
      const r = row as Record<string, unknown>;
      const value = Number(r.value ?? r.y ?? r.amount);
      return Number.isFinite(value) ? [{ label: scalar(r.label ?? r.name ?? r.x) || String(index + 1), value }] : [];
    }
    return [];
  });

  // Friendly fallback: `label | value` or `label, value` per line.
  if (data.length === 0) {
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim() || /^(type|title|data)\s*:/i.test(line)) continue;
      const parts = line.split(/\s*[|,]\s*/);
      const value = Number(parts.at(-1));
      if (parts.length >= 2 && Number.isFinite(value)) data.push({ label: parts.slice(0, -1).join(" ").trim() || String(index + 1), value });
    }
  }
  if (data.length === 0 || !["bar", "line", "pie"].includes(type)) return null;
  const title = scalar(object.title);
  return {
    type: type as ChartSpec["type"],
    ...(title ? { title } : {}),
    data: data.slice(0, 40),
  };
}

/** Parse JSON or `time | title | detail | status` timeline rows. */
export function parseTimelineSpec(source: string): TimelineEvent[] {
  const raw = source.trim();
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).events)
      ? (parsed as Record<string, unknown>).events as unknown[]
      : [];
  const events: TimelineEvent[] = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const title = scalar(r.title ?? r.name ?? r.event);
    if (!title) return [];
    const status = scalar(r.status).toLowerCase();
    return [{
      time: scalar(r.time ?? r.date ?? r.timestamp),
      title,
      detail: scalar(r.detail ?? r.description ?? r.body) || undefined,
      status: ["done", "active", "pending", "error"].includes(status) ? status as TimelineEvent["status"] : undefined,
    }];
  });
  if (events.length > 0) return events.slice(0, 40);
  return raw.split("\n").flatMap((line) => {
    const trimmed = line.replace(/^[-*]\s*/, "").trim();
    if (!trimmed) return [];
    const parts = trimmed.split(/\s*\|\s*/);
    if (parts.length < 2) return [];
    const status = parts[3]?.toLowerCase();
    return [{ time: parts[0], title: parts[1], detail: parts[2] || undefined,
      status: ["done", "active", "pending", "error"].includes(status) ? status as TimelineEvent["status"] : undefined }];
  }).slice(0, 40);
}

// ── Syntax highlighting ───────────────────────────────────────────────────────

/** T-15: token-based syntax highlighter for TypeScript/JavaScript/JSON/shell. */
function highlightCode(code: string[], width = DEFAULT_WIDTH): React.ReactNode[] {
  const kw = new Set(["const", "let", "var", "function", "async", "await", "return",
    "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
    "try", "catch", "finally", "throw", "class", "extends", "import", "export",
    "from", "default", "new", "typeof", "instanceof", "void", "in", "of",
    "interface", "type", "enum", "implements", "private", "public", "protected",
    "readonly", "abstract", "override", "declare", "namespace", "module"]);
  const typeKw = new Set(["string", "number", "boolean", "any", "unknown", "never",
    "null", "undefined", "void", "object", "true", "false", "Promise", "Array",
    "Record", "Partial", "Required", "Omit", "Pick", "keyof", "infer"]);

  const codeWidth = Math.max(8, width - 6);
  return code.slice(0, MAX_CODE_LINES).map((sourceLine, i) => {
    const line = clip(sourceLine, codeWidth);
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

function chartPreview(spec: ChartSpec, width: number): React.JSX.Element {
  const chartWidth = Math.max(24, Math.min(72, width - 8));
  const max = Math.max(...spec.data.map((p) => Math.abs(p.value)), 1);
  const min = Math.min(...spec.data.map((p) => p.value), 0);
  const range = Math.max(1, max - min);
  const labelWidth = Math.min(14, Math.max(4, ...spec.data.map((p) => p.label.length)));
  const plotWidth = Math.max(12, chartWidth - labelWidth - 10);
  const title = spec.title ? ` ${spec.title} ` : ` ${spec.type} chart `;
  const rows = spec.data.map((point, index) => {
    const ratio = (point.value - min) / range;
    const filled = Math.max(0, Math.min(plotWidth, Math.round(ratio * plotWidth)));
    const bar = "█".repeat(filled) + "░".repeat(plotWidth - filled);
    const marker = spec.type === "line" ? (index === 0 ? "╭" : index === spec.data.length - 1 ? "╰" : "│") : "▌";
    return ` ${point.label.slice(0, labelWidth).padEnd(labelWidth)} ${marker}${bar} ${String(point.value)}`;
  });
  if (spec.type === "pie") {
    const total = spec.data.reduce((sum, p) => sum + Math.max(0, p.value), 0) || 1;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.table} bold>┌─{title}{"─".repeat(Math.max(0, chartWidth - title.length - 2))}┐</Text>
        {spec.data.map((p, i) => {
          const pct = Math.round((Math.max(0, p.value) / total) * 100);
          const pieBarWidth = Math.max(1, chartWidth - labelWidth - 9);
          const pieBar = "█".repeat(Math.min(pieBarWidth, Math.max(1, Math.round((pct / 100) * pieBarWidth))));
          return <Text key={i} color={theme.code}>│ {p.label.slice(0, labelWidth).padEnd(labelWidth)} {String(pct).padStart(3)}% {pieBar.padEnd(pieBarWidth, " ")}</Text>;
        })}
        <Text color={theme.table} bold>└{"─".repeat(chartWidth)}┘</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.table} bold>┌─{title}{"─".repeat(Math.max(0, chartWidth - title.length - 2))}┐</Text>
      {rows.map((row, i) => <Text key={i} color={theme.code}>│{row}</Text>)}
      <Text color={theme.table} bold>└{"─".repeat(chartWidth)}┘</Text>
    </Box>
  );
}

function timelinePreview(events: TimelineEvent[], width: number): React.JSX.Element {
  const detailWidth = Math.max(16, width - 18);
  const icon = (status?: TimelineEvent["status"]) => status === "done" ? "✓" : status === "error" ? "✗" : status === "active" ? "◆" : "○";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.table} bold> timeline · {events.length} event{events.length === 1 ? "" : "s"}</Text>
      {events.map((event, i) => (
        <Box key={i} flexDirection="column">
          <Text>
            <Text color={event.status === "error" ? theme.error : event.status === "done" ? theme.success : theme.accent} bold>
              {icon(event.status)}
            </Text>
            <Text dimColor> {clip(event.time || "—", 16).padEnd(16)} </Text>
            <Text bold>{clip(event.title, detailWidth)}</Text>
          </Text>
          {event.detail && <Text dimColor>  {i === events.length - 1 ? " " : "│"} {clip(event.detail, detailWidth)}</Text>}
          {i < events.length - 1 && <Text dimColor>  │</Text>}
        </Box>
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

export function Markdown({ text, width }: { text: string; width?: number }): React.JSX.Element {
  const paneWidth = contentWidth(width);
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

      if ((lang === "chart" || lang.startsWith("chart:")) && code.length > 0) {
        const chart = parseChartSpec(code.join("\n"), lang);
        blocks.push(chart ? <Box key={key++}>{chartPreview(chart, paneWidth)}</Box> : <Text key={key++} dimColor>  (invalid chart data)</Text>);
        continue;
      }

      if ((lang === "timeline" || lang === "events") && code.length > 0) {
        const events = parseTimelineSpec(code.join("\n"));
        blocks.push(events.length > 0 ? <Box key={key++}>{timelinePreview(events, paneWidth)}</Box> : <Text key={key++} dimColor>  (empty timeline)</Text>);
        continue;
      }

      // T-15: syntax-highlighted code block
      blocks.push(
        <Box key={key++} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>
          {lang && <Text dimColor bold>{lang}</Text>}
           {code.length === 0 ? (
            <Text dimColor>(empty)</Text>
          ) : (
            highlightCode(code, paneWidth)
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
      const available = Math.max(20, paneWidth - 4);
      const naturalWidths = header.map((h, c) =>
        Math.min(MAX_CELL, Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length))),
      );
      const separators = Math.max(0, header.length - 1) * 3 + 4;
      const totalNatural = naturalWidths.reduce((sum, n) => sum + n, 0);
      const widths = naturalWidths.map((n) =>
        totalNatural + separators <= available ? n : Math.max(3, Math.floor((n / Math.max(1, totalNatural)) * (available - separators))),
      );
      const renderRow = (cells: string[], chars: { l: string; m: string; r: string }, color?: string, bold?: boolean, rowKey?: string) => {
        const line =
          chars.l + widths.map((width, ci) => {
            const cell = cells[ci] ?? "";
            return (cell.length > width ? cell.slice(0, Math.max(1, width - 1)) + "…" : cell).padEnd(width, " ");
          }).join(chars.m) + chars.r;
        return <Text key={rowKey} color={color} bold={bold}>{clip(line, paneWidth)}</Text>;
      };
      blocks.push(
        <Box key={key++} flexDirection="column" marginTop={1}>
           {renderRow(header, { l: "┌ ", m: " ┬ ", r: " ┐" }, theme.table, true, `th${key}`)}
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

    blocks.push(<Text key={key++}>{renderInline(clip(line, paneWidth), `t${key}`)}</Text>);
    i++;
  }

  return <Box flexDirection="column">{blocks}</Box>;
}
