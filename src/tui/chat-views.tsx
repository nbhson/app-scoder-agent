/**
 * T2: chat item views — Spinner, ToolItemView, DiffItemView, TodoItemView,
 * ChatItemView. Tách khỏi app.tsx (component-based, pattern từ opencode
 * packages/tui).
 */
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { ChatItem } from "./state.js";
import { Markdown } from "./markdown.js";
import { detectImageCaps, halfblockRows } from "./image.js"; // T7
import { AgentMark, fit, theme, toolIcon } from "./theme.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
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
  return <Text color="cyan">{frame}</Text>;
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

function ToolItemView({ item }: { item: Extract<ChatItem, { kind: "tool" }> }): React.JSX.Element {
  const running = item.ok === null;

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
        <Text dimColor>{String(item.step).padStart(2, "0")}▸ </Text>
        <Text color={theme.accent}>{toolIcon(item.name)} </Text>
        <Text color={item.ok === false ? theme.error : theme.accent} bold>{item.name}</Text>
        {keyArg && <Text dimColor> {keyArg}</Text>}
        {running && <Text dimColor> · running</Text>}
        {!running && elapsed && <Text dimColor> · {elapsed}</Text>}
      </Text>

      {/* Output preview */}
      {preview.map((line, i) => (
        <Text key={i} dimColor>
          {"  └ "}{line.length > 140 ? line.slice(0, 140) + "…" : line}
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

/** One colored line of a unified diff (+ green, - red, @@ cyan, header bold). */
export function DiffLine({ line }: { line: string }): React.JSX.Element {
  if (line.startsWith("+++") || line.startsWith("---")) return <Text bold>{line}</Text>;
  if (line.startsWith("@@")) return <Text color="cyan">{line}</Text>;
  if (line.startsWith("+")) return <Text color="green">{line}</Text>;
  if (line.startsWith("-")) return <Text color="red">{line}</Text>;
  return <Text>{line}</Text>;
}

const MAX_DIFF_RENDER_LINES = 20;

/**
 * Polished diff card — rounded border, step badge, color-coded + and - lines.
 * Header row: [step] ✎ [+/− stats] [path]
 * Body: up to MAX_DIFF_RENDER_LINES of colored diff lines.
 */
function DiffItemView({ item }: { item: Extract<ChatItem, { kind: "diff" }> }): React.JSX.Element {
  const lines = item.text.length > 0 ? item.text.split("\n") : [];
  const shown = lines.slice(0, MAX_DIFF_RENDER_LINES);
  const hidden = lines.length - shown.length;
  const addedColor = item.added > 0 ? theme.success : undefined;
  const removedColor = item.removed > 0 ? theme.error : undefined;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      marginTop={1}
      marginLeft={1}
    >
      {/* Header: step badge + ✎ icon + stats + path */}
      <Text>
        <Text dimColor>{String(item.step).padStart(2, "0")}▸ </Text>
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
        <DiffLine key={i} line={line.length > 160 ? line.slice(0, 160) + "…" : line} />
      ))}
      {hidden > 0 && (
        <Text dimColor>  … +{hidden} more diff lines</Text>
      )}
    </Box>
  );
}

/**
 * Plan KHÔNG còn render trong chat — checklist live hiển thị ở Sidebar bên
 * phải (sidebar.tsx, PlanSection) để transcript sạch; todo items vẫn được
 * giữ trong state (latestPlan) làm nguồn dữ liệu cho sidebar.
 */
function TodoItemView(): null {
  return null;
}

export function ChatItemView({ item }: { item: ChatItem }): React.JSX.Element | null {
  switch (item.kind) {
    case "user":
      // User messages stand out with a full colored border + bold label so they're
      // immediately visible at a glance, distinct from the agent's ◆ markdown.
      return (
        <Box marginTop={1} marginLeft={1}>
          <Box
            borderStyle="single"
            borderColor={theme.user}
            borderLeft={true}
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            backgroundColor="gray"
            width="100%"
            paddingX={1}
            paddingTop={0}
            flexDirection="column"
          >
            <Text>
              <Text color="white" bold>you ▸ </Text>
              <Text color="white" bold>{item.text}</Text>
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
          <Markdown text={item.text} />
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
      return <ToolItemView item={item} />;
    case "diff":
      return <DiffItemView item={item} />;
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
}
