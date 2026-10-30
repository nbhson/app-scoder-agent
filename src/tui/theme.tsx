/**
 * TUI design system — one palette + icon set shared by every view so the
 * screen stays visually consistent. Ink color names only (16-color safe).
 */
import React from "react";
import { Text } from "ink";

export const theme = {
  brand: "magenta",
  accent: "cyan",
  success: "green",
  error: "red",
  warn: "yellow",
  user: "blue",
  dim: "gray",
  border: "gray",
} as const;

/** Icon per tool name — compact visual vocabulary for the flight recorder. */
const TOOL_ICONS: Record<string, string> = {
  list_files: "🗂",
  read_file: "📖",
  write_file: "📝",
  edit_file: "✏️",
  run_command: "⚡",
  web_fetch: "🌐",
  write_todos: "☑",
};

export function toolIcon(name: string): string {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name.startsWith("mcp__")) return "🔌";
  return "🔧";
}

/** Truncate to max chars (suffix ellipsis), keeping a single line. */
export function fit(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

/** The agent's signature mark, used as an avatar on assistant output. */
export function AgentMark(): React.JSX.Element {
  return <Text color={theme.brand} bold>◆ </Text>;
}
