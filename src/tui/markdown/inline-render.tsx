/**
 * Inline tokens → Ink <Text> elements. Shared by render.tsx (paragraphs,
 * headings, lists, quotes) and table.tsx (cell content).
 */
import React from "react";
import { Text } from "ink";
import { theme } from "../theme.js";
import { tokenizeInline } from "./inline.js";

/** Render inline markdown as nested Ink <Text> elements. */
export function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return tokenizeInline(text).map((token, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (token.type) {
      case "code":
        return <Text key={key} color={theme.code}>{token.text}</Text>;
      case "bold":
        return <Text key={key} bold>{token.text}</Text>;
      case "italic":
        return <Text key={key} italic>{token.text}</Text>;
      case "strike":
        return <Text key={key} strikethrough dimColor>{token.text}</Text>;
      case "link":
        return (
          <Text key={key}>
            <Text color="blue" underline>{token.text}</Text>
            <Text dimColor> ({token.url})</Text>
          </Text>
        );
      default:
        return token.text;
    }
  });
}
