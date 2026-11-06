/**
 * Diagram & data previews: mermaid structured summary, ```chart fences
 * (bar/line/pie), ```timeline fences. All boxes are measured in display cells
 * (text-width.ts) — borders stay aligned with Unicode/emoji content.
 *
 * Mermaid strategy: NO real graph layout in the terminal. We parse the source
 * just enough to show an honest structured summary (type, nodes, edges,
 * participants, messages). Unsupported/complex diagrams fall back to
 * syntax-highlighted source + a friendly note.
 */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { charset } from "../charset.js";
import { clipCells, measure, padEndCells } from "../text-width.js";

// ── Chart / timeline specs (unchanged data formats) ─────────────────────────

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

// ── Bordered content box (cell-measured) ────────────────────────────────────

/** Render content lines inside a properly aligned box sized to `width` cells. */
export function ContentBox({ title, lines, width, color }: {
  title: string;
  lines: string[];
  width: number;
  color?: string;
}): React.JSX.Element {
  const inner = Math.max(10, width - 2); // 2 border cells
  const titleText = ` ${title} `;
  const topFill = Math.max(0, inner - measure(titleText) - 1);
  const borderColor = color ?? theme.table;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.table} bold>{charset.tl}{charset.h}{clipCells(titleText, inner - 1)}{charset.h.repeat(topFill)}{charset.tr}</Text>
      {lines.map((line, i) => (
        <Text key={i}>
          <Text color={theme.table}>{charset.v}</Text>
          <Text color={borderColor}> {padEndCells(clipCells(line, inner - 1), inner - 1)}</Text>
          <Text color={theme.table}>{charset.v}</Text>
        </Text>
      ))}
      <Text color={theme.table} bold>{charset.bl}{charset.h.repeat(inner)}{charset.br}</Text>
    </Box>
  );
}

// ── Mermaid ─────────────────────────────────────────────────────────────────

interface MermaidSummary {
  type: string;
  supported: boolean;
  lines: string[];
}

/** Node id: any word char + unicode letters, optionally quoted label. */
const MERMAID_NODE_RX = /([\p{L}\p{N}_]+)\s*(\[\s*(?:[^\]]*)\s*\]|\(\s*(?:[^)]*)\s*\)|\{\s*(?:[^}]*)\s*\}|\(\(\s*(?:[^)]*)\s*\)\))/gu;
/** Node id with optional shape, so `A[Start] --> B{Valid?}` still parses. */
const NODE_WITH_SHAPE = String.raw`([\p{L}\p{N}_]+)(?:\(\([^)]*\)\)|\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?`;
const MERMAID_EDGE_RX = new RegExp(
  NODE_WITH_SHAPE + String.raw`\s*(--?>?|-.->|==>|<--?>|x--?x|o--?o|---)\s*(?:\|([^|]*)\|)?\s*` + NODE_WITH_SHAPE,
  "gu",
);

/** Strip surrounding shape brackets to get the label: "[Start]" → "Start". */
function nodeLabel(shape: string): string {
  return shape.replace(/^[[({]+|[)\]}]+$/g, "").trim().replace(/^"|"$/g, "");
}

export function summarizeMermaid(source: string[]): MermaidSummary {
  const text = source.join("\n");
  const typeMatch = /^\s*(\w+)/.exec(text);
  const type = typeMatch?.[1] ?? "unknown";

  if (/^(graph|flowchart)$/.test(type)) {
    const nodeMap = new Map<string, string>();
    for (const m of text.matchAll(MERMAID_NODE_RX)) {
      const label = nodeLabel(m[2] ?? "");
      if (label) nodeMap.set(m[1], label);
    }
    const edges: Array<{ from: string; to: string; label?: string }> = [];
    for (const m of text.matchAll(MERMAID_EDGE_RX)) {
      edges.push({ from: m[1], to: m[4], ...(m[3]?.trim() ? { label: m[3].trim() } : {}) });
    }
    const lines: string[] = [`flowchart · ${nodeMap.size} nodes · ${edges.length} edges`, ""];
    for (const [id, label] of [...nodeMap.entries()].slice(0, 6)) {
      lines.push(`◦ ${label}  (${id})`);
    }
    if (nodeMap.size > 6) lines.push(`… ${nodeMap.size - 6} more nodes`);
    const nameOf = (id: string) => nodeMap.get(id) ?? id;
    for (const e of edges.slice(0, 8)) {
      lines.push(`${nameOf(e.from)} → ${nameOf(e.to)}${e.label ? `  : ${e.label}` : ""}`);
    }
    if (edges.length > 8) lines.push(`… ${edges.length - 8} more edges`);
    return { type: "flowchart", supported: true, lines };
  }

  if (type === "sequenceDiagram") {
    const aliases = new Map<string, string>();
    for (const m of text.matchAll(/(?:participant|actor)\s+([\p{L}\p{N}_]+)(?:\s+as\s+(.+))?/giu)) {
      aliases.set(m[1], m[2]?.trim() ?? m[1]);
    }
    const messages: Array<{ from: string; to: string; text: string }> = [];
    for (const m of text.matchAll(/([\p{L}\p{N}_]+)\s*(?:->>|-->>|->|-->|-\)|--\))\s*([\p{L}\p{N}_]+)\s*:\s*(.+)/gu)) {
      messages.push({ from: m[1], to: m[2], text: m[3].trim() });
    }
    const nameOf = (id: string) => aliases.get(id) ?? id;
    const lines: string[] = [
      `sequence · ${aliases.size} participants · ${messages.length} messages`,
      "",
    ];
    if (aliases.size > 0) lines.push(`participants: ${[...aliases.values()].slice(0, 6).join(", ")}`);
    for (const msg of messages.slice(0, 8)) {
      lines.push(`${nameOf(msg.from)} → ${nameOf(msg.to)}: ${msg.text}`);
    }
    if (messages.length > 8) lines.push(`… ${messages.length - 8} more messages`);
    return { type: "sequence", supported: true, lines };
  }

  const KNOWN_UNSUPPORTED = /^(stateDiagram|stateDiagram-v2|erDiagram|classDiagram|gitGraph|gantt|pie|journey|mindmap|timeline|quadrantChart|sankey|xychart-beta|block-beta|packet-beta|architecture-beta|requirementDiagram|C4Context)$/;
  if (KNOWN_UNSUPPORTED.test(type)) {
    return {
      type,
      supported: false,
      lines: [`${type} — preview not supported for this diagram type`],
    };
  }

  return {
    type,
    supported: false,
    lines: [`${type || "unknown"} — unknown diagram type`],
  };
}

const MERMAID_EXPORT_HINT = "export: npx @mermaid-js/mermaid-cli -i <file> -o out.svg";
const MAX_SOURCE_LINES = 12;

/** Mermaid block: structured summary box; unsupported types → source + note. */
export function MermaidPreview({ source, width }: { source: string[]; width: number }): React.JSX.Element {
  const summary = summarizeMermaid(source);
  if (summary.supported) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>  ◉ mermaid diagram</Text>
        <ContentBox title="◈ diagram preview" lines={[...summary.lines, "", MERMAID_EXPORT_HINT]} width={Math.min(width, 72)} color={theme.mermaid} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>  ◉ mermaid diagram — {summary.lines[0]}</Text>
      {source.slice(0, MAX_SOURCE_LINES).map((l, i) => (
        <Text key={i} color={theme.mermaid}>  {clipCells(l, Math.max(8, width - 2))}</Text>
      ))}
      {source.length > MAX_SOURCE_LINES && (
        <Text dimColor>  … +{source.length - MAX_SOURCE_LINES} more lines</Text>
      )}
      <Text dimColor>  {MERMAID_EXPORT_HINT}</Text>
    </Box>
  );
}

// ── Chart fence ─────────────────────────────────────────────────────────────

export function ChartPreview({ spec, width }: { spec: ChartSpec; width: number }): React.JSX.Element {
  const chartWidth = Math.max(24, Math.min(72, width - 8));
  const max = Math.max(...spec.data.map((p) => Math.abs(p.value)), 1);
  const min = Math.min(...spec.data.map((p) => p.value), 0);
  const range = Math.max(1, max - min);
  const labelWidth = Math.min(14, Math.max(4, ...spec.data.map((p) => measure(p.label))));
  const valueWidth = Math.max(1, ...spec.data.map((p) => String(p.value).length));
  // Row = label + " " + marker + bar + " " + value ≤ chartWidth-3 (ContentBox
  // padding) → plot budget = chartWidth - labelWidth - valueWidth - 6.
  const plotWidth = Math.max(12, chartWidth - labelWidth - valueWidth - 6);

  if (spec.type === "pie") {
    const total = spec.data.reduce((sum, p) => sum + Math.max(0, p.value), 0) || 1;
    const lines = spec.data.map((p) => {
      const pct = Math.round((Math.max(0, p.value) / total) * 100);
      // Row = label + " " + "NN%" + " " + bar ≤ chartWidth-3 → -9.
      const barWidth = Math.max(1, chartWidth - labelWidth - 9);
      const bar = charset.blockFull.repeat(Math.min(barWidth, Math.max(1, Math.round((pct / 100) * barWidth))));
      return `${padEndCells(clipCells(p.label, labelWidth), labelWidth)} ${String(pct).padStart(3)}% ${bar}`;
    });
    return <ContentBox title={spec.title ?? "pie chart"} lines={lines} width={chartWidth} color={theme.code} />;
  }

  const rows = spec.data.map((point) => {
    const ratio = (point.value - min) / range;
    const filled = Math.max(0, Math.min(plotWidth, Math.round(ratio * plotWidth)));
    const bar = charset.blockFull.repeat(filled) + charset.blockEmpty.repeat(plotWidth - filled);
    return `${padEndCells(clipCells(point.label, labelWidth), labelWidth)} ▌${bar} ${String(point.value).padStart(valueWidth)}`;
  });
  return <ContentBox title={spec.title ?? `${spec.type} chart`} lines={rows} width={chartWidth} color={theme.code} />;
}

// ── Timeline fence ──────────────────────────────────────────────────────────

export function TimelinePreview({ events, width }: { events: TimelineEvent[]; width: number }): React.JSX.Element {
  const detailWidth = Math.max(16, width - 18);
  const icon = (status?: TimelineEvent["status"]) => status === "done" ? charset.ok : status === "error" ? charset.fail : status === "active" ? charset.active : charset.pending;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.table} bold> timeline · {events.length} event{events.length === 1 ? "" : "s"}</Text>
      {events.map((event, i) => (
        <Box key={i} flexDirection="column">
          <Text>
            <Text color={event.status === "error" ? theme.error : event.status === "done" ? theme.success : theme.accent} bold>
              {icon(event.status)}
            </Text>
            <Text dimColor> {padEndCells(clipCells(event.time || "—", 16), 16)} </Text>
            <Text bold>{clipCells(event.title, detailWidth)}</Text>
          </Text>
          {event.detail && <Text dimColor>  {i === events.length - 1 ? " " : charset.v} {clipCells(event.detail, detailWidth)}</Text>}
          {i < events.length - 1 && <Text dimColor>  {charset.v}</Text>}
        </Box>
      ))}
    </Box>
  );
}
