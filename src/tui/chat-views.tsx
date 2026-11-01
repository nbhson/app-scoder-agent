/**
 * T2: chat item views — Spinner, ToolItemView, DiffItemView, TodoItemView,
 * ChatItemView. Tách khỏi app.tsx (component-based, pattern từ opencode
 * packages/tui).
 */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ChatItem } from "./state.js";
import { Markdown } from "./markdown.js";
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

const OUTPUT_PREVIEW_LINES = 2;

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
  const icon = running ? <Spinner active /> : item.ok ? <Text color={theme.success}>✔</Text> : <Text color={theme.error}>✘</Text>;
  // One meaningful arg per tool type keeps the line scannable.
  const keyArg =
    typeof item.args.command === "string"
      ? fit(item.args.command, 48)
      : typeof item.args.path === "string"
        ? fit(item.args.path, 40)
        : Object.keys(item.args).length > 0
          ? fit(Object.keys(item.args).join(","), 24)
          : "";
  const preview = previewLines(item.output);
  const elapsed =
    item.durationMs != null
      ? item.durationMs >= 10_000
        ? `${(item.durationMs / 1000).toFixed(0)}s`
        : `${(item.durationMs / 1000).toFixed(1)}s`
      : null;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <Text dimColor>{String(item.step).padStart(2, "0")}▸ </Text>
        {icon} <Text color={theme.accent}>{toolIcon(item.name)} {item.name}</Text>
        {keyArg && <Text dimColor> {keyArg}</Text>}
        {running && <Text dimColor> …</Text>}
        {elapsed && <Text dimColor> ({elapsed})</Text>}
      </Text>
      {preview.map((line, i) => (
        <Text key={i} dimColor>
          {"  └ "}{line.length > 140 ? line.slice(0, 140) + "…" : line}
        </Text>
      ))}
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

const MAX_DIFF_RENDER_LINES = 24;

function DiffItemView({ item }: { item: Extract<ChatItem, { kind: "diff" }> }): React.JSX.Element {
  const lines = item.text.length > 0 ? item.text.split("\n") : [];
  const shown = lines.slice(0, MAX_DIFF_RENDER_LINES);
  const hidden = lines.length - shown.length;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      marginLeft={1}
    >
      <Text>
        <Text dimColor>{String(item.step).padStart(2, "0")}▸</Text>{" "}
        <Text color="magenta" bold>
          ✎
        </Text>{" "}
        <Text color="green">+{item.added}</Text> <Text color="red">-{item.removed}</Text>{" "}
        <Text bold>{item.path}</Text>
        {item.truncated && <Text color="yellow"> (diff truncated)</Text>}
      </Text>
      {shown.map((line, i) => (
        <DiffLine key={i} line={line.length > 160 ? line.slice(0, 160) + "…" : line} />
      ))}
      {hidden > 0 && <Text dimColor>… +{hidden} more diff lines</Text>}
    </Box>
  );
}

/** Live plan — checkbox list with per-status colors. */
function TodoItemView({ item }: { item: Extract<ChatItem, { kind: "todo" }> }): React.JSX.Element {
  const done = item.items.filter((t) => t.status === "completed").length;
  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={1}>
      <Text>
        <AgentMark />
        <Text bold>plan </Text>
        <Text dimColor>{done}/{item.items.length}</Text>
      </Text>
      {item.items.map((t, i) => (
        <Text key={i}>
          <Text> </Text>
          {t.status === "completed" ? (
            <>
              <Text color={theme.success}>✔ </Text>
              <Text color={theme.success} dimColor>{fit(t.content, 80)}</Text>
            </>
          ) : t.status === "in_progress" ? (
            <>
              <Text color={theme.accent}>◆ </Text>
              <Text color={theme.accent} bold>{fit(t.content, 80)}</Text>
            </>
          ) : (
            <>
              <Text dimColor>○ </Text>
              <Text dimColor>{fit(t.content, 80)}</Text>
            </>
          )}
        </Text>
      ))}
    </Box>
  );
}

export function ChatItemView({ item }: { item: ChatItem }): React.JSX.Element | null {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={theme.user} bold>
            ❯{" "}
          </Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case "assistant": {
      // Finalized messages render as markdown; while streaming, raw dim text
      // (cheap — markdown layout of partial text would jump around anyway).
      if (item.streaming || !item.text) {
        return (
          <Box marginTop={item.text ? 1 : 0} paddingLeft={1}>
            <AgentMark />
            <Text dimColor={item.streaming}>{item.text || (item.streaming ? "" : "(no text)")}</Text>
            {item.streaming && <Text color={theme.accent}>▋</Text>}
          </Box>
        );
      }
      return (
        <Box marginTop={1} paddingLeft={1}>
          <AgentMark />
          <Markdown text={item.text} />
        </Box>
      );
    }
    case "thinking":
      // T-10: reasoning stream — dim italic, ✻ prefix.
      return (
        <Box paddingLeft={1}>
          <Text dimColor italic>
            ✻ {item.text.split("\n").slice(-3).join("\n  ")}
          </Text>
        </Box>
      );
    case "tool":
      return <ToolItemView item={item} />;
    case "diff":
      return <DiffItemView item={item} />;
    case "todo":
      return <TodoItemView item={item} />;
    case "build":
      return (
        <Box paddingLeft={1}>
          {item.success ? <Text color={theme.success} bold>✔ build passed</Text> : <Text color={theme.error} bold>✘ build failed</Text>}
          <Text dimColor> — {item.command}</Text>
        </Box>
      );
    case "notice":
      return (
        <Box paddingLeft={1}>
          <Text color={item.level === "error" ? theme.error : item.level === "warn" ? theme.warn : theme.dim}>
            {item.level === "error" ? "✘ " : "⚠ "}
            {item.text.length > 2000 ? item.text.slice(0, 2000) + "…" : item.text}
          </Text>
        </Box>
      );
  }
}
