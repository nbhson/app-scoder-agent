import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";

export interface AskUserModalProps {
  question: string;
  options?: string[];
  multiple?: boolean;
  onAnswer: (answer: string) => void;
  onCancel: () => void;
}

/** Modal for ask_user tool — single/multi choice + free text. */
export function AskUserModal({ question, options, multiple, onAnswer, onCancel }: AskUserModalProps): React.JSX.Element {
  const [input, setInput] = useState("");
  useInput((ch, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { onAnswer(input.trim() || (options?.[0] ?? "")); return; }
    if (key.backspace) { setInput((v) => v.slice(0, -1)); return; }
    if (ch && !key.ctrl && !key.meta) setInput((v) => v + ch);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} paddingY={1}>
      <Text color={theme.accent} bold>❓ {question}</Text>
      {options?.length ? (
        <Box flexDirection="column" marginTop={1}>
          {options.map((o, i) => <Text key={i}>{i + 1}. {o}</Text>)}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>{multiple ? "comma-separated choices" : "type answer"}: </Text>
        <Text>{input}</Text>
        <Text color={theme.accent}>▌</Text>
      </Box>
      <Text dimColor>Enter submit · Esc cancel</Text>
    </Box>
  );
}
