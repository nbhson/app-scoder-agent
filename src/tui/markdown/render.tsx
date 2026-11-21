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

// ── Syntax highlighting — table-driven (plan P5 / A8) ──────────────────────
// One keyword/comment/string table per language family; unknown langs keep the
// historical JS/TS behavior (no regression). tree-sitter was deliberately NOT
// used here: native dep + per-line parse cost on the streaming hot path —
// same precedent as context/repo-map.ts.

interface LangRule {
  keywords: Set<string>;
  types: Set<string>;
  /** Line-comment prefixes (`//`, `#`, `--`, …). */
  lineComment: string[];
  /** [open, close] block comment, or absent. */
  blockComment?: [string, string];
  /** Single-char string delimiters. */
  quotes: string[];
  /** SQL-style: keywords match case-insensitively. */
  ci?: boolean;
}

const kw = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const JS: LangRule = {
  keywords: kw(`const let var function async await return if else for while do
    switch case break continue try catch finally throw class extends import export from
    default new typeof instanceof void in of interface type enum implements private public
    protected readonly abstract override declare namespace module static get set yield delete`),
  types: kw(`string number boolean any unknown never null undefined void object true
    false Promise Array Record Partial Required Omit Pick keyof infer`),
  lineComment: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'", "`"],
};

const LANG_RULES: Record<string, LangRule> = {
  js: JS, jsx: JS, ts: JS, tsx: JS, javascript: JS, typescript: JS, mjs: JS, cjs: JS,
  python: {
    keywords: kw(`def class return if elif else for while import from as try except finally
      with raise yield lambda pass break continue global nonlocal assert del async await
      in is not and or None True False self cls print len range`),
    types: kw(`str int float bool bytes list dict tuple set object None`),
    lineComment: ["#"], quotes: ['"', "'", "`"],
  },
  go: {
    keywords: kw(`package import func return if else for range switch case default defer go
      chan select type struct interface map make new const var break continue fallthrough goto`),
    types: kw(`nil true false string int int8 int32 int64 uint float32 float64 bool byte rune error`),
    lineComment: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'", "`"],
  },
  rust: {
    keywords: kw(`fn let mut const static struct enum impl trait for while loop if else match
      return pub use mod crate self super where dyn ref move unsafe async await macro_rules`),
    types: kw(`true false None Some Ok Err String str char i8 i16 i32 i64 i128 u8 u16 u32 u64
      usize isize f32 f64 bool Box Vec Option Result`),
    lineComment: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'"],
  },
  java: {
    keywords: kw(`public private protected class interface extends implements new return if else
      for while do switch case break continue try catch finally throw throws import package
      static final abstract synchronized volatile transient enum this super instanceof var
      record sealed yield assert`),
    types: kw(`null true false void int long double float boolean char byte short String Integer
      List Map Set Optional Object`),
    lineComment: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'"],
  },
  c: {
    keywords: kw(`struct union enum typedef return if else for while do switch case break
      continue sizeof static const extern volatile register goto auto`),
    types: kw(`void int char float double long short unsigned signed size_t FILE NULL bool`),
    lineComment: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'"],
  },
  cpp: {
    keywords: kw(`class template namespace public private protected new delete virtual override
      final using try catch throw this operator friend inline explicit constexpr auto static
      const struct enum typedef if else for while switch case return break continue sizeof
      noexcept extern mutable goto`),
    types: kw(`bool true false nullptr void int char float double long short unsigned signed
      string vector map set pair optional`),
    lineComment: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'"],
  },
  sql: {
    keywords: kw(`select from where insert into values update set delete create table alter add
      column primary key foreign references unique index join inner left right full outer
      cross on group by order having limit offset as and or not null distinct union all case
      when then else end exists between like is in any some with recursive view procedure
      function trigger commit rollback transaction begin grant revoke explain analyze`),
    types: kw(`count sum avg min max coalesce cast integer int bigint serial text varchar char
      boolean date timestamp time numeric decimal real json jsonb uuid`),
    lineComment: ["--"], blockComment: ["/*", "*/"], quotes: ['"', "'", "`"], ci: true,
  },
  bash: {
    keywords: kw(`if then elif else fi for while until do done in case esac function echo exit
      export local readonly return set unset shift source alias eval exec trap break continue
      read printf select time cd test`),
    types: kw(`true false`),
    lineComment: ["#"], quotes: ['"', "'", "`"],
  },
  sh: {
    keywords: kw(`if then elif else fi for while until do done in case esac function return
      export local readonly source alias exec trap break continue read printf cd test`),
    types: kw(`true false`),
    lineComment: ["#"], quotes: ['"', "'"],
  },
  json: { keywords: kw(`true false null`), types: new Set(), lineComment: [], quotes: ['"', "'"] },
  yaml: { keywords: kw(`true false null yes no on off`), types: new Set(), lineComment: ["#"], quotes: ['"', "'"] },
  toml: { keywords: kw(`true false`), types: new Set(), lineComment: ["#", ";"], quotes: ['"', "'"] },
};

/** Alias table — file-extension-ish info strings map onto families. */
const LANG_ALIASES: Record<string, string> = {
  py: "python", python3: "python", golang: "go", rs: "rust", h: "c", cc: "cpp", cxx: "cpp",
  hpp: "cpp", shell: "sh", zsh: "bash", yml: "yaml", jsonc: "json", postgres: "sql",
  postgresql: "sql", mysql: "sql",
};

export function ruleFor(lang: string): LangRule {
  const l = lang.trim().toLowerCase();
  if (!l) return JS;
  return LANG_RULES[l] ?? LANG_RULES[LANG_ALIASES[l] ?? ""] ?? JS;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Compiled {
  re: RegExp;
  block?: [string, string];
}

const COMPILED = new Map<string, Compiled>();

/** Tokenizer per rule — group order is fixed: 1 string | 2 comment | 3 number | 4 word. */
function compile(rule: LangRule): Compiled {
  const key = [rule.keywords.size, rule.lineComment.join(","), rule.blockComment?.join("") ?? "", rule.quotes.join("")].join("|");
  const hit = COMPILED.get(key);
  if (hit) return hit;
  const stringAlt = rule.quotes.map((q) => `${esc(q)}(?:[^\\\\${esc(q)}]|\\\\.)*${esc(q)}`).join("|");
  const commentParts: string[] = [];
  if (rule.blockComment) commentParts.push(`${esc(rule.blockComment[0])}[\\s\\S]*?(?:${esc(rule.blockComment[1])}|$)`);
  for (const cm of rule.lineComment) commentParts.push(`${esc(cm)}[^\\n]*`);
  const src =
    `(${stringAlt})` +
    // `(?!))` never matches — keeps group indices stable for comment-less langs.
    (commentParts.length > 0 ? `|(${commentParts.join("|")})` : "|((?!))") +
    `|(\\b0x[\\da-fA-F]+|\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b)|(\\w+)`;
  const out: Compiled = { re: new RegExp(src, "g"), block: rule.blockComment };
  COMPILED.set(key, out);
  return out;
}

/**
 * Highlight one logical line. `inBlockComment` carries multi-line comment
 * state across lines (returned so the caller can thread it through the block).
 * Node keys derive from nodes.length — no separate counter.
 *
 * P-perf (item 14): result memo. CodeBlock re-highlights every visible line
 * on EVERY ink render (streaming repaints run at frame rate) — but the
 * output depends ONLY on (lang, line, inBlockComment) and React elements are
 * immutable descriptors, so the node array is safely shareable. LRU-bounded
 * Map (hit moves to the tail) so a long session can't grow it without limit.
 */
const highlightMemo = new Map<string, { nodes: React.ReactNode[]; inBlockComment: boolean }>();
const HIGHLIGHT_MAX = 4096;

const RULE_SIG = new WeakMap<LangRule, string>();
let RULE_SEQ = 0;
function ruleSig(rule: LangRule): string {
  let s = RULE_SIG.get(rule);
  if (!s) {
    s = `r${RULE_SEQ++}_`;
    RULE_SIG.set(rule, s);
  }
  return s;
}

function highlightLine(line: string, inBlockComment: boolean, rule: LangRule): { nodes: React.ReactNode[]; inBlockComment: boolean } {
  const key = `${ruleSig(rule)}${inBlockComment ? "\u0001" : "\u0002"}${line}`;
  const hit = highlightMemo.get(key);
  if (hit) {
    highlightMemo.delete(key);
    highlightMemo.set(key, hit);
    return hit;
  }
  const result = highlightLineCore(line, inBlockComment, rule);
  if (highlightMemo.size >= HIGHLIGHT_MAX) {
    const oldest = highlightMemo.keys().next();
    if (!oldest.done) highlightMemo.delete(oldest.value);
  }
  highlightMemo.set(key, result);
  return result;
}

function highlightLineCore(line: string, inBlockComment: boolean, rule: LangRule): { nodes: React.ReactNode[]; inBlockComment: boolean } {
  const nodes: React.ReactNode[] = [];
  const keyed = (color: string | undefined, text: string, bold = false): void => {
    nodes.push(<Text key={`n${nodes.length}`} color={color} bold={bold}>{text}</Text>);
  };
  const c = compile(rule);

  if (inBlockComment && c.block) {
    const end = line.indexOf(c.block[1]);
    if (end === -1) {
      return { nodes: [<Text key="bc" color={theme.thinking}>{line}</Text>], inBlockComment: true };
    }
    keyed(theme.thinking, line.slice(0, end + c.block[1].length));
    const rest = highlightLine(line.slice(end + c.block[1].length), false, rule);
    nodes.push(...rest.nodes.map((n, i) => (typeof n === "object" && n !== null ? React.cloneElement(n as React.ReactElement, { key: `r${i}` }) : n)));
    return { nodes, inBlockComment: false };
  }

  let last = 0;
  let openComment = false;
  for (const m of line.matchAll(c.re)) {
    if (m.index > last) nodes.push(line.slice(last, m.index));
    const tok = m[0];
    if (m[1]) keyed(theme.code, tok);
    else if (m[2]) {
      keyed(theme.thinking, tok);
      if (c.block && tok.startsWith(c.block[0]) && !tok.endsWith(c.block[1])) openComment = true;
    }
    else if (m[3]) keyed("magenta", tok);
    else {
      const word = rule.ci ? tok.toLowerCase() : tok;
      if (rule.keywords.has(word)) keyed("cyan", tok, true);
      else if (rule.types.has(word)) keyed("yellow", tok);
      else nodes.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return { nodes, inBlockComment: openComment };
}

// ── Block renderers ──────────────────────────────────────────────────────────

function CodeBlock({ lang, lines, width }: { lang: string; lines: string[]; width: number }): React.JSX.Element {
  const rule = ruleFor(lang);
  const gutter = String(Math.min(lines.length, MAX_CODE_LINES)).length;
  const codeWidth = Math.max(8, width - gutter - 6); // gutter + "│ " + border + padding
  const shown = lines.slice(0, MAX_CODE_LINES);
  const elements: React.JSX.Element[] = [];
  let inBlockComment = false;

  shown.forEach((sourceLine, i) => {
    const wrapped = wrapCells(sourceLine === "" ? " " : sourceLine, codeWidth);
    wrapped.forEach((segment, wi) => {
      const hl = highlightLine(segment, inBlockComment, rule);
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
