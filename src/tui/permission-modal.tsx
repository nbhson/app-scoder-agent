/**
 * T2/T3: PermissionModal — khối modal permission_request. T3: full unified
 * diff có màu (DiffLine), scroll được (pageUp/pageDown do TuiApp điều phối
 * qua useInput chung), không cắt cứng 12 dòng.
 */
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { DiffLine } from "./chat-views.js";
import { theme } from "./theme.js";

export interface PermissionModalProps {
  prompt: {
    kind: string;
    label: string;
    diff?: string;
    timeoutSecs: number;
  };
}

const MODAL_DIFF_WINDOW = 20; // rows hiển thị cùng lúc; scroll bằng pgup/pgdn

/**
 * Permission request modal — elevated visual with a bold colored header
 * bar, the command preview, a scrollable diff (if any), and the key legend.
 */
export function PermissionModal({ prompt }: PermissionModalProps): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const lines = prompt.diff ? prompt.diff.split("\n") : [];
  useInput((_input, key) => {
    if (key.pageUp) setOffset((o) => Math.min(o + MODAL_DIFF_WINDOW, Math.max(0, lines.length - 1)));
    if (key.pageDown) setOffset((o) => Math.max(0, o - MODAL_DIFF_WINDOW));
    if (key.home) setOffset(lines.length); // top (clamped below)
    if (key.end) setOffset(0); // bottom
  });
  const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - MODAL_DIFF_WINDOW)));
  const shown = lines.slice(start, start + MODAL_DIFF_WINDOW);
  const hasMoreAbove = start > 0;
  const hasMoreBelow = start + MODAL_DIFF_WINDOW < lines.length;

  return (
    <Box flexDirection="column" borderStyle="bold" borderColor={theme.warn} paddingX={1} paddingY={1}>
      {/* Header bar */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={theme.warn} bold>⚠ permission — {prompt.kind}</Text>
        <Text dimColor>timeout {prompt.timeoutSecs}s → deny</Text>
      </Box>

      {/* Command description */}
      <Text bold>{prompt.label}</Text>

      {/* Diff (if any) */}
      {prompt.diff && (
        <Box flexDirection="column" marginTop={1}>
          {hasMoreAbove && <Text dimColor>↑ {start} earlier lines</Text>}
          {shown.map((l, i) => (
            <DiffLine key={start + i} line={l.length > 160 ? l.slice(0, 160) + "…" : l} />
          ))}
          {hasMoreBelow && (
            <Text dimColor>↓ {lines.length - start - MODAL_DIFF_WINDOW} more lines</Text>
          )}
        </Box>
      )}

      {/* Key legend */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{"─".repeat(28)}</Text>
        <Text dimColor>  y · a · n · q  to answer</Text>
        {prompt.diff && <Text dimColor>  pgup · pgdn · home · end  scroll diff</Text>}
      </Box>
    </Box>
  );
}
