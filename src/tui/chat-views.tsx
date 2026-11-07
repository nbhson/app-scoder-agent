/**
 * T2: chat item views — Spinner, ToolItemView, DiffItemView, TodoItemView,
 * ChatItemView. Tách khỏi app.tsx (component-based, pattern từ opencode
 * packages/tui).
 */
import React, { memo, useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { ChatItem } from "./state.js";
import { Markdown } from "./markdown.js";
import { detectImageCaps, halfblockRows } from "./image.js"; // T7
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

/** T7: decode data URL → halfblock rows (null khi không PNG/không decode được). */
function halfblockFromDataUrl(dataUrl: string): Array<{ text: string }> | null {
  const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    return halfblockRows(Buffer.from(m[2], "base64"));
  } catch {
    return null;
  }
}

/** Collapse run_command scaffolding ("--- stdout ---" etc.) to real content. */
function previewLines(output: string): string[] {
  const lines = output
    .replace(/\n+$/, "")
    .split("\n")
    .filter((l) => !/^--- (stdout|stderr) ---$/.test(l.trim()));
  return lines.slice(-OUTPUT_PREVIEW_LINES);
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
  const caps = useMemo(() => detectImageCaps(), []);
  const halfblocks = useMemo(
    () => (item.image && caps.truecolor ? halfblockFromDataUrl(item.image) : null),
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
      // Streaming: dim with pulsing cursor; finalized: markdown with agent mark.
      if (item.streaming || !item.text) {
        return (
          <Box marginTop={item.text ? 1 : 0} paddingLeft={2}>
            <AgentMark />
            <Text dimColor={item.streaming}>{item.text || (item.streaming ? "" : "(no text)")}</Text>
            {item.streaming && <Text color={theme.accent} bold>▋</Text>}
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
