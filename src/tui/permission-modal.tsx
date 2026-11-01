/**
 * T2: PermissionModal — khối modal permission_request (T-03). Tách khỏi
 * app.tsx. Keybind handling vẫn ở TuiApp (useInput tập trung).
 */
import React from "react";
import { Box, Text } from "ink";

export interface PermissionModalProps {
  prompt: {
    kind: string;
    label: string;
    diff?: string;
    timeoutSecs: number;
  };
}

export function PermissionModal({ prompt }: PermissionModalProps): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        ⚠ permission required — {prompt.kind}
      </Text>
      <Text>{prompt.label}</Text>
      {prompt.diff && (
        <Box flexDirection="column" marginTop={1}>
          {prompt.diff.split("\n").slice(0, 12).map((l, i) => (
            <Text key={i} color={l.startsWith("+") ? "green" : l.startsWith("-") ? "red" : undefined}>
              {l}
            </Text>
          ))}
          {prompt.diff.split("\n").length > 12 && <Text dimColor>… (truncated)</Text>}
        </Box>
      )}
      <Text dimColor>
        [y] yes · [a] always · [n] no · [q] quit — timeout {prompt.timeoutSecs}s ⇒ deny
      </Text>
    </Box>
  );
}
