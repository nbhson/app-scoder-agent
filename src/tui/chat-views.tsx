/**
 * T2: chat item views — Spinner, ToolItemView, DiffItemView, TodoItemView,
 * ChatItemView. Tách khỏi app.tsx (component-based, pattern từ opencode
 * packages/tui).
 */
import React, { memo, useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { ChatItem } from "./state.js";
import { Markdown } from "./markdown.js";
import { detectImageCaps, halfblockRowsFromDataUrl } from "./image.js"; // T7
import { AgentMark, fit, theme, toolIcon } from "./theme.js";
import { clipCells } from "./text-width.js";
import { boxBorderStyle, charset } from "./charset.js";

const SPINNER_FRAMES = charset.spinner;
const SPINNER_MS = 80;

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_MS);
    return () => clearInterval(timer);
  }, [active]);
  return SPINNER_FRAMES[frame];
}

/**
 * Isolated spinner: owns its own 80ms timer so animation frames re-render
 * ONLY this component — not the whole tree (the previous design lifted the
 * frame state into TuiApp, re-rendering every chat item 12x/second → flicker).
 */
export function Spinner({ active }: { active: boolean }): React.JSX.Element | null {
  const frame = useSpinner(active);
  if (!active) return null;
  return <Text color={theme.accent}>{frame}</Text>;
}

const OUTPUT_PREVIEW_LINES = 5;
const SCAFFOLD_RX = /^--- (stdout|stderr) ---$/;

/** Collapse run_command scaffolding ("--- stdout ---" etc.) to real content.
 *
 * P-perf (item 12): TAIL scan via lastIndexOf — a 200 KB build log used to
 * allocate a 5k-string array + a replace() copy just to render 5 lines, on
 * EVERY ToolItemView re-render inside a live ink tree. Walks backward from
 * the trimmed end, collecting exactly the last ≤5 non-scaffold lines.
 * Identical to the old split+filter+slice(-5) for every input, including
 * the "" → [""] and "\n\n" → [""] cases and a leading empty segment
 * ("first line" before a newline at offset 0). */
function previewLines(output: string): string[] {
  let end = output.length;
  while (end > 0 && output.charCodeAt(end - 1) === 10) end--; // trim /\n+$/
  const out: string[] = [];
  let cursor = end;
  for (;;) {
    const nl = cursor > 0 ? output.lastIndexOf("\n", cursor - 1) : -1;
    const line = output.slice(nl + 1, cursor);
    if (!SCAFFOLD_RX.test(line.trim())) out.push(line);
    if (out.length >= OUTPUT_PREVIEW_LINES) break;
    if (nl === -1) break; // processed the first segment
    cursor = nl;
    if (cursor === 0) {
      if (!SCAFFOLD_RX.test("")) out.push(""); // segment before a newline at offset 0
      break;
    }
  }
  return out.reverse();
}

function ToolItemView({ item, width }: { item: Extract<ChatItem, { kind: "tool" }>; width?: number }): React.JSX.Element {
  const running = item.ok === null;
  const outputWidth = Math.max(24, (width ?? 100) - 6);

  // One meaningful arg per tool type keeps the line scannable.
  const keyArg =
    typeof item.args.command === "string"
      ? fit(item.args.command, 60)
      : typeof item.args.path === "string"
        ? fit(item.args.path, 40)
        : Object.keys(item.args).length > 0
          ? fit(Object.keys(item.args).join(","), 24)
          : "";

  const preview = previewLines(item.output);

  // T7: image result — halfblock preview khi terminal truecolor, fallback link.
  // P-perf: decode qua module-level LRU (halfblockRowsFromDataUrl) — survives
  // virtualization remounts, mỗi ảnh chỉ decode một lần mỗi phiên.
  const caps = useMemo(() => detectImageCaps(), []);
  const halfblocks = useMemo(
    () => (item.image && caps.truecolor ? halfblockRowsFromDataUrl(item.image) : null),
    [item.image, caps.truecolor],
  );

  // T6: live elapsed cho tool đang chạy
  const liveElapsed = item.ok === null && item.startedAt != null ? Date.now() - item.startedAt : null;
  const elapsedMs = item.durationMs ?? liveElapsed;
  const elapsed =
    elapsedMs != null
      ? elapsedMs >= 10_000
        ? `${(elapsedMs / 1000).toFixed(0)}s`
        : `${(elapsedMs / 1000).toFixed(1)}s`
      : null;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* Step prefix + icon + tool name + args + elapsed */}
      <Text>
        <Text dimColor>{String(item.step).padStart(2, "0")} ▸ </Text>
        <Text color={theme.accent}>{toolIcon(item.name)} </Text>
        <Text color={item.ok === false ? theme.error : theme.accent} bold>{item.name}</Text>
        {keyArg && <Text dimColor> {keyArg}</Text>}
        {running && <Text dimColor> · running</Text>}
        {!running && (
          // A2: explicit status glyph — name color alone was too subtle to scan.
          item.ok ? (
            <Text color={theme.success}> {charset.ok}</Text>
          ) : (
            <Text color={theme.error}> {charset.fail}</Text>
          )
        )}
        {!running && elapsed && <Text dimColor> · {elapsed}</Text>}
      </Text>

      {/* Output preview */}
      {preview.map((line, i) => (
        <Text key={i} dimColor>
          {"  └ "}{clipCells(line, outputWidth)}
        </Text>
      ))}

      {/* Image preview */}
      {halfblocks && (
        <Box flexDirection="column" paddingLeft={2}>
          {halfblocks.map((r, i) => (
            <Text key={i}>{r.text}</Text>
          ))}
          <Text dimColor>  └ image preview</Text>
        </Box>
      )}
      {item.image && !halfblocks && (
        <Text dimColor>  └ image — {item.output}</Text>
      )}
    </Box>
  );
}

/** One colored line of a unified diff (+ success, - error, @@ accent, header bold). */
export function DiffLine({ line }: { line: string }): React.JSX.Element {
  if (line.startsWith("+++") || line.startsWith("---")) return <Text bold>{line}</Text>;
  if (line.startsWith("@@")) return <Text color={theme.accent}>{line}</Text>;
  if (line.startsWith("+")) return <Text color={theme.success}>{line}</Text>;
  if (line.startsWith("-")) return <Text color={theme.error}>{line}</Text>;
  return <Text>{line}</Text>;
}

const MAX_DIFF_RENDER_LINES = 20;

/**
 * Polished diff card — rounded border, step badge, color-coded + and - lines.
 * Header row: [step] ✎ [+/− stats] [path]
 * Body: up to MAX_DIFF_RENDER_LINES of colored diff lines.
 */
function DiffItemView({ item, width }: { item: Extract<ChatItem, { kind: "diff" }>; width?: number }): React.JSX.Element {
  const lines = item.text.length > 0 ? item.text.split("\n") : [];
  const shown = lines.slice(0, MAX_DIFF_RENDER_LINES);
  const hidden = lines.length - shown.length;
  const diffWidth = Math.max(24, (width ?? 100) - 6);
  const addedColor = item.added > 0 ? theme.success : undefined;
  const removedColor = item.removed > 0 ? theme.error : undefined;

  return (
    <Box
      flexDirection="column"
      borderStyle={boxBorderStyle()}
      borderColor={theme.border}
      paddingX={1}
      marginTop={1}
      marginLeft={1}
    >
      {/* Header: step badge + ✎ icon + stats + path */}
      <Text>
        <Text dimColor>{String(item.step).padStart(2, "0")} ▸ </Text>
        <Text color={theme.brand} bold>✎</Text>
        <Text>  </Text>
        <Text color={addedColor}>+{item.added}</Text>
        <Text> </Text>
        <Text color={removedColor}>-{item.removed}</Text>
        <Text>  </Text>
        <Text bold color={theme.accent}>{item.path}</Text>
        {item.truncated && <Text dimColor> · diff truncated</Text>}
      </Text>

      {/* Diff body */}
      {shown.map((line, i) => (
        <DiffLine key={i} line={clipCells(line, diffWidth)} />
      ))}
      {hidden > 0 && (
        <Text dimColor>  … +{hidden} more diff lines</Text>
      )}
    </Box>
  );
}

/**
 * Plan KHÔNG còn render trong chat — checklist live hiển thị ở Sidebar bên
 * phải (sidebar.tsx, PlanSection) để transcript sạch; plan hiển thị từ
 * state.plan (field riêng, miễn nhiễm MAX_ITEMS eviction trên run dài).
 */
function TodoItemView(): null {
  return null;
}

/**
 * Field-level equality for ChatItem — defense-in-depth cho React.memo.
 * state.ts cập nhật item theo kiểu immutable (patchItem thay object trong
 * array): item đổi nội dung ⇒ đổi reference ⇒ memo thấy khác và re-render.
 * (Regression cũ: mutate in-place + memo ⇒ prev/next là CÙNG object ⇒ mọi
 * so sánh đều "bằng" ⇒ stream đóng băng ở chunk đầu, tool kẹt "running".)
 */
function chatItemEqual(a: ChatItem, b: ChatItem): boolean {
  if (a === b && a.kind !== "assistant" && a.kind !== "thinking" && a.kind !== "tool") return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "user":
      return a.text === (b as typeof a).text;
    case "assistant":
    case "thinking": {
      const bb = b as typeof a;
      return a.text === bb.text && a.streaming === bb.streaming;
    }
    case "tool": {
      const bb = b as typeof a;
      return a.name === bb.name && a.ok === bb.ok && a.output === bb.output
        && a.step === bb.step && a.durationMs === bb.durationMs && a.image === bb.image;
    }
    case "diff": {
      const bb = b as typeof a;
      return a.text === bb.text && a.path === bb.path && a.added === bb.added && a.removed === bb.removed;
    }
    case "todo": {
      const bb = b as typeof a;
      return a.items === bb.items;
    }
    case "build": {
      const bb = b as typeof a;
      return a.success === bb.success && a.command === bb.command;
    }
    case "compaction": {
      const bb = b as typeof a;
      return a.tokensBefore === bb.tokensBefore && a.tokensAfter === bb.tokensAfter && a.manual === bb.manual;
    }
    case "notice": {
      const bb = b as typeof a;
      return a.text === bb.text && a.level === bb.level;
    }
  }
}

/**
 * Memoized: during streaming, events flush at ~20 fps and previously forced
 * EVERY chat item to re-render (O(n²) over a long transcript). Old finalized
 * items now skip rendering entirely; only the item actually changed by the
 * last event batch re-renders.
 */
export const ChatItemView = memo(function ChatItemView({ item, width }: { item: ChatItem; width?: number }): React.JSX.Element | null {
  switch (item.kind) {
    case "user":
      // User messages stand out with a clean left accent border (│) + bold
      // label — no full-width background block (design-system: subtle,
      // scannable, không phá nhịp đọc của transcript).
      return (
        <Box marginTop={1} marginLeft={1}>
          <Box
            borderStyle="single"
            borderColor={theme.user}
            borderLeft={true}
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            width="100%"
            paddingX={1}
            flexDirection="column"
          >
            <Text>
              <Text color={theme.user} bold>you ▸ </Text>
              <Text bold>{item.text}</Text>
            </Text>
          </Box>
        </Box>
      );
    case "assistant": {
      // P-stream: streaming renders the SAME markdown pipeline as the
      // finalized view (with ▋ appended as trailing inline text). Raw source
      // text used to be shown while generating — hard-wrapped paragraphs and
      // runs of blank lines appeared exactly as the model typed them, then
      // "snapped" into shape on completion (the reported "unnecessary line
      // breaks during generation, normal when done"). The parser collapses
      // blank-line runs into one spacer, so both phases now agree live.
      if (item.streaming) {
        if (!item.text) {
          return (
            <Box paddingLeft={2}>
              <AgentMark />
              <Text color={theme.accent} bold>▋</Text>
            </Box>
          );
        }
        return (
          <Box marginTop={1} paddingLeft={2}>
            <AgentMark />
            <Markdown text={`${item.text}▋`} width={width} />
          </Box>
        );
      }
      if (!item.text) {
        return (
          <Box paddingLeft={2}>
            <AgentMark />
            <Text dimColor={false}>{"(no text)"}</Text>
          </Box>
        );
      }
      return (
        <Box marginTop={1} paddingLeft={2}>
          <AgentMark />
          <Markdown text={item.text} width={width} />
        </Box>
      );
    }
    case "thinking":
      // T-10: reasoning stream — dim color, ⊙ prefix, collapse to last 4 lines.
      return (
        <Box paddingLeft={1} marginTop={1}>
          <Text color={theme.thinking} italic>
            <Text dimColor>⊙</Text> {item.text.split("\n").slice(-4).join("\n  ")}
          </Text>
        </Box>
      );
    case "tool":
      return <ToolItemView item={item} width={width} />;
    case "diff":
      return <DiffItemView item={item} width={width} />;
    case "todo":
      return <TodoItemView />;
    case "build":
      // Rich build status card: large icon + bold label + dim command
      return (
        <Box paddingLeft={1} marginTop={1}>
          <Box flexDirection="column">
            <Text>
              {item.success
                ? <Text color={theme.success} bold>✓ build passed</Text>
                : <Text color={theme.error} bold>✗ build FAILED</Text>}
            </Text>
            <Text dimColor>   {item.command}</Text>
          </Box>
        </Box>
      );
    case "compaction": {
      // Divider marking an LLM summarization of older history.
      const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
      return (
        <Box paddingLeft={1} marginTop={1}>
          <Text dimColor italic>
            ── {item.manual ? "compacted (manual)" : "compacted"}: {fmt(item.tokensBefore)} → {fmt(item.tokensAfter)} tokens ───
          </Text>
        </Box>
      );
    }
    case "notice":
      return (
        <Box paddingLeft={2} marginTop={1}>
          <Text
            color={
              item.level === "error" ? theme.error :
              item.level === "warn" ? theme.warn :
              theme.dim
            }
          >
            {item.level === "error" ? "✗ " : item.level === "warn" ? "⚠ " : "  "}
            {item.text.length > 2000 ? item.text.slice(0, 2000) + "…" : item.text}
          </Text>
        </Box>
      );
  }
}, (prev, next) => prev.width === next.width && chatItemEqual(prev.item, next.item));
