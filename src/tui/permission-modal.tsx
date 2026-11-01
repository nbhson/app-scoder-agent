/**
 * T2/T3: PermissionModal — khối modal permission_request. T3: full unified
 * diff có màu (DiffLine), scroll được (pageUp/pageDown do TuiApp điều phối
 * qua useInput chung), không cắt cứng 12 dòng.
 */
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { DiffLine } from "./chat-views.js";

export interface PermissionModalProps {
  prompt: {
    kind: string;
    label: string;
    diff?: string;
    timeoutSecs: number;
  };
}

const MODAL_DIFF_WINDOW = 20; // rows hiển thị cùng lúc; scroll bằng pgup/pgdn

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
  const hidden = lines.length - shown.length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        ⚠ permission required — {prompt.kind}
      </Text>
      <Text>{prompt.label}</Text>
      {prompt.diff && (
        <Box flexDirection="column" marginTop={1}>
          {shown.map((l, i) => (
            <DiffLine key={start + i} line={l.length > 160 ? l.slice(0, 160) + "…" : l} />
          ))}
          {start > 0 && <Text dimColor>… ↑ {start} earlier lines (pgup/pgdn scroll)</Text>}
          {start + MODAL_DIFF_WINDOW < lines.length && <Text dimColor>… ↓ {lines.length - start - MODAL_DIFF_WINDOW} more lines (pgup/pgdn scroll)</Text>}
        </Box>
      )}
      <Text dimColor>
        [y] yes/once · [a] always/session · [n] no · [q] quit · pgup/pgdn diff — timeout {prompt.timeoutSecs}s ⇒ deny
      </Text>
    </Box>
  );
}
