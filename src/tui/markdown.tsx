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

    // Numbered list — keep the numbering as-is
    if (/^\s*\d+\.\s+/.test(line)) {
      blocks.push(<Text key={key++}>{renderInline(line.trimStart(), `n${key}`)}</Text>);
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
