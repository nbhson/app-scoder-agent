/**
 * Block AST → Ink elements. All layout decisions (clip/pad/wrap) go through
 * text-width.ts so borders and columns stay aligned with Unicode content.
 */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { boxBorderStyle, charset } from "../charset.js";
import { measure, wrapCells } from "../text-width.js";
import type { Block, ListItem } from "./ast.js";
import { renderInline } from "./inline-render.js";
import { TableView } from "./table.js";
import {
  ChartPreview,
  MermaidPreview,
  TimelinePreview,
  parseChartSpec,
  parseTimelineSpec,
} from "./diagram.js";

const MAX_CODE_LINES = 60;

// ── Syntax highlighting (JS/TS/JSON/shell keyword sets) ─────────────────────

const KEYWORDS = new Set(["const", "let", "var", "function", "async", "await", "return",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "try", "catch", "finally", "throw", "class", "extends", "import", "export",
  "from", "default", "new", "typeof", "instanceof", "void", "in", "of",
  "interface", "type", "enum", "implements", "private", "public", "protected",
  "readonly", "abstract", "override", "declare", "namespace", "module"]);
const TYPE_KEYWORDS = new Set(["string", "number", "boolean", "any", "unknown", "never",
  "null", "undefined", "void", "object", "true", "false", "Promise", "Array",
  "Record", "Partial", "Required", "Omit", "Pick", "keyof", "infer"]);

/**
 * Highlight one logical line. `inBlockComment` carries multi-line comment
 * state across lines (returned so the caller can thread it through the block).
 * Node keys derive from nodes.length — no separate counter.
 */
function highlightLine(line: string, inBlockComment: boolean): { nodes: React.ReactNode[]; inBlockComment: boolean } {
  const nodes: React.ReactNode[] = [];
  const keyed = (color: string | undefined, text: string, bold = false): void => {
    nodes.push(<Text key={`n${nodes.length}`} color={color} bold={bold}>{text}</Text>);
  };

  if (inBlockComment) {
    const end = line.indexOf("*/");
    if (end === -1) {
      return { nodes: [<Text key="bc" color={theme.thinking}>{line}</Text>], inBlockComment: true };
    }
    keyed(theme.thinking, line.slice(0, end + 2));
    const rest = highlightLine(line.slice(end + 2), false);
    nodes.push(...rest.nodes.map((n, i) => (typeof n === "object" && n !== null ? React.cloneElement(n as React.ReactElement, { key: `r${i}` }) : n)));
    return { nodes, inBlockComment: false };
  }

  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(\b0x[\da-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?\b)|(\w+)/g;
  let last = 0;
  let openComment = false;
  for (const m of line.matchAll(re)) {
    if (m.index > last) nodes.push(line.slice(last, m.index));
    const tok = m[0];
    if (m[1]) keyed(theme.code, tok);
    else if (m[2]) {
      keyed(theme.thinking, tok);
      if (tok.startsWith("/*") && !tok.endsWith("*/")) openComment = true;
    }
    else if (m[3]) keyed("magenta", tok);
    else if (KEYWORDS.has(tok)) keyed("cyan", tok, true);
    else if (TYPE_KEYWORDS.has(tok)) keyed("yellow", tok);
    else nodes.push(tok);
    last = m.index + tok.length;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return { nodes, inBlockComment: openComment };
}

// ── Block renderers ──────────────────────────────────────────────────────────

function CodeBlock({ lang, lines, width }: { lang: string; lines: string[]; width: number }): React.JSX.Element {
  const gutter = String(Math.min(lines.length, MAX_CODE_LINES)).length;
  const codeWidth = Math.max(8, width - gutter - 6); // gutter + "│ " + border + padding
  const shown = lines.slice(0, MAX_CODE_LINES);
  const elements: React.JSX.Element[] = [];
  let inBlockComment = false;

  shown.forEach((sourceLine, i) => {
    const wrapped = wrapCells(sourceLine === "" ? " " : sourceLine, codeWidth);
    wrapped.forEach((segment, wi) => {
      const hl = highlightLine(segment, inBlockComment);
      inBlockComment = hl.inBlockComment;
      elements.push(
        <Text key={`${i}-${wi}`}>
          {wi === 0
            ? <Text dimColor>{String(i + 1).padStart(gutter, " ")} {charset.v} </Text>
            : <Text dimColor>{" ".repeat(gutter)} {charset.cont} </Text>}
          {hl.nodes}
        </Text>,
      );
    });
  });

  return (
    <Box flexDirection="column" borderStyle={boxBorderStyle()} borderColor={theme.border} paddingX={1} marginTop={1}>
      {lang && <Text dimColor bold>{lang}</Text>}
      {lines.length === 0 ? <Text dimColor>(empty)</Text> : elements}
      {lines.length > MAX_CODE_LINES && (
        <Text dimColor>  … +{lines.length - MAX_CODE_LINES} more lines (omitted)</Text>
      )}
    </Box>
  );
}

function ListBlock({ items, width }: { items: ListItem[]; width: number }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const indent = "  ".repeat(item.depth);
        const marker = item.checked !== undefined
          ? (item.checked ? `${charset.taskDone} ` : `${charset.taskTodo} `)
          : item.marker
            ? `${item.marker} `
            : `${charset.bullet} `;
        const prefixWidth = measure(indent + marker);
        const bodyWidth = Math.max(8, width - prefixWidth);
        const wrappedLines = wrapCells(item.text, bodyWidth);
        return (
          <Box key={i} flexDirection="column">
            {wrappedLines.map((l, wi) => (
              <Text key={wi}>
                {wi === 0 ? (
                  <Text color={item.marker ? "cyan" : theme.accent}>{indent}{marker}</Text>
                ) : (
                  <Text>{" ".repeat(prefixWidth)}</Text>
                )}
                {item.checked
                  ? <Text dimColor strikethrough>{renderInline(l, `l${i}-${wi}`)}</Text>
                  : renderInline(l, `l${i}-${wi}`)}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

function QuoteBlock({ text, width }: { text: string; width: number }): React.JSX.Element {
  const bodyWidth = Math.max(8, width - 2);
  return (
    <Box flexDirection="column">
      {text.split("\n").flatMap((line, li) =>
        wrapCells(line, bodyWidth).map((segment, wi) => (
          <Text key={`${li}-${wi}`} dimColor>
            <Text color={theme.dim}>{charset.v} </Text>
            <Text italic>{renderInline(segment, `q${li}-${wi}`)}</Text>
          </Text>
        )),
      )}
    </Box>
  );
}

/** Render one block; returns null for spacers handled by margin. */
export function renderBlock(block: Block, width: number, key: number): React.JSX.Element | null {
  switch (block.kind) {
    case "spacer":
      return <Text key={key}> </Text>;
    case "hr":
      return <Text key={key} dimColor>{charset.h.repeat(Math.min(width, 60))}</Text>;
    case "heading":
      return (
        <Text key={key} bold color={block.level <= 2 ? "magenta" : "cyan"}>
          {renderInline(block.text, `h${key}`)}
        </Text>
      );
    case "paragraph":
      return (
        <Box key={key} flexDirection="column">
          {wrapCells(block.text, width).map((l, wi) => (
            <Text key={wi}>{renderInline(l, `p${key}-${wi}`)}</Text>
          ))}
        </Box>
      );
    case "code":
      return <CodeBlock key={key} lang={block.lang} lines={block.lines} width={width} />;
    case "table":
      return <TableView key={key} header={block.header} align={block.align} rows={block.rows} width={width} />;
    case "list":
      return <ListBlock key={key} items={block.items} width={width} />;
    case "quote":
      return <QuoteBlock key={key} text={block.text} width={width} />;
    case "mermaid":
      return (
        <Box key={key} marginTop={1} flexDirection="column">
          <MermaidPreview source={block.lines} width={width} />
        </Box>
      );
    case "chart": {
      const chart = parseChartSpec(block.source, block.lang);
      return chart
        ? <Box key={key} flexDirection="column"><ChartPreview spec={chart} width={width} /></Box>
        : <Text key={key} dimColor>  (invalid chart data)</Text>;
    }
    case "timeline": {
      const events = parseTimelineSpec(block.source);
      return events.length > 0
        ? <Box key={key} flexDirection="column"><TimelinePreview events={events} width={width} /></Box>
        : <Text key={key} dimColor>  (empty timeline)</Text>;
    }
  }
}
