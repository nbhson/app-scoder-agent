/**
 * Markdown renderer for the TUI chat pane — orchestrator.
 *
 * Pipeline: text → parse.ts (Block AST) → render.tsx (Ink elements), with
 * table.tsx / diagram.tsx / inline-render.tsx as block renderers and
 * text-width.ts as the single source of truth for display-cell layout.
 *
 * Supported:
 * - Fenced code blocks with syntax highlighting, line numbers, soft-wrapping
 * - Mermaid diagram blocks (```mermaid) → structured summary preview
 * - # Headers (1-6, bold)
 * - GFM tables with full unicode borders, alignment row, cell wrapping,
 *   narrow-pane key-value fallback, row cap
 * - `chart` fences (bar/line/pie) rendered as terminal-native charts
 * - `timeline` fences rendered as an accessible vertical event rail
 * - Bullets + task lists (- [ ] / - [x]), numbered lists (nested by indent)
 * - > Quotes (dim, left bar, wrapped)
 * - Horizontal rules (--- / *** / ___)
 * - Inline `code` / **bold** / *italic* / ~~strike~~ / [link](url) / escapes
 *
 * Long lines wrap to the measured pane width so Ink never overflows.
 *
 * Re-exports kept stable for existing tests/importers: parseChartSpec,
 * parseTimelineSpec, ChartSpec, ChartPoint, TimelineEvent.
 */
import React from "react";
import { Box } from "ink";
import { parseMarkdown } from "./markdown/parse.js";
import { renderBlock } from "./markdown/render.js";
import type { Block } from "./markdown/ast.js";

export {
  parseChartSpec,
  parseTimelineSpec,
  type ChartSpec,
  type ChartPoint,
  type TimelineEvent,
} from "./markdown/diagram.js";
export { parseMarkdown } from "./markdown/parse.js";
export { tokenizeInline, inlineToPlain } from "./markdown/inline.js";
export type { Block, InlineToken, ListItem, TableAlign } from "./markdown/ast.js";

const DEFAULT_WIDTH = 100;

function contentWidth(width?: number): number {
  return Math.max(32, Math.floor(width ?? DEFAULT_WIDTH));
}

/**
 * Parse cache: finalized assistant messages are immutable, so re-renders
 * (sidebar tick, scroll, resize) must not re-parse. Small LRU keyed by text;
 * parse depends only on the text, not the width.
 */
const PARSE_CACHE_MAX = 50;
const parseCache = new Map<string, Block[]>();

function parseCached(text: string): Block[] {
  const hit = parseCache.get(text);
  if (hit) {
    // Refresh recency (LRU).
    parseCache.delete(text);
    parseCache.set(text, hit);
    return hit;
  }
  const blocks = parseMarkdown(text);
  parseCache.set(text, blocks);
  if (parseCache.size > PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  return blocks;
}

export function Markdown({ text, width }: { text: string; width?: number }): React.JSX.Element {
  const paneWidth = contentWidth(width);
  const blocks = parseCached(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => renderBlock(block, paneWidth, i))}
    </Box>
  );
}
