/**
 * Session Picker Modal — keyboard-navigable list of saved sessions.
 *
 * Opens via "/" when the agent is idle (no task running).
 * ↑/↓ navigate, Enter select, Esc cancel.
 *
 * Shows: id (truncated), task, date, step count, build status.
 */
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { listSessions, type SessionSummary } from "../session/session.js";
import { theme, fit } from "./theme.js";

export interface SessionPickerProps {
  workdir: string;
  onSelect: (session: SessionSummary) => void;
  onClose: () => void;
}

const DISPLAY_LIMIT = 12;

export function SessionPicker({ workdir, onSelect, onClose }: SessionPickerProps): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const all = listSessions(workdir).slice(0, DISPLAY_LIMIT);
    setSessions(all);
    setSelected(0);
  }, [workdir]);

  // Keyboard navigation — captures everything while the picker is open.
  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(sessions.length - 1, s + 1));
      return;
    }
    if (key.return) {
      if (sessions.length > 0) {
        onSelect(sessions[selected]);
      }
      return;
    }
    // Vim-style j/k navigation
    if (_input === "k" && !key.ctrl && !key.meta) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (_input === "j" && !key.ctrl && !key.meta) {
      setSelected((s) => Math.min(sessions.length - 1, s + 1));
      return;
    }
    // Quick-jump by number (1-9 selects that entry)
    const n = parseInt(_input, 10);
    if (n >= 1 && n <= sessions.length) {
      setSelected(n - 1);
      return;
    }
  });

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} paddingY={1}>
        <Text color={theme.brand} bold>
          ← saved sessions
        </Text>
        <Text dimColor>no saved sessions found</Text>
        <Text dimColor>esc to close</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} paddingY={1}>
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={theme.brand} bold>
          ← saved sessions
        </Text>
        <Text dimColor>{sessions.length} session{sessions.length !== 1 ? "s" : ""}</Text>
      </Box>

      {/* Divider */}
      <Box>
        <Text dimColor>{"─".repeat(38)}</Text>
      </Box>

      {/* Session list */}
      {sessions.map((s, i) => {
        const isSelected = i === selected;
        const idPart = s.id.slice(0, 14);
        const dateStr = s.updatedAt ? s.updatedAt.slice(0, 16).replace("T", " ") : "—";

        return (
          <Box key={s.id} flexDirection="column" paddingLeft={isSelected ? 0 : 1}>
            {/* First row: selection mark + id + date + steps */}
            <Text
              color={isSelected ? theme.brand : theme.dim}
              bold={isSelected}
              dimColor={!isSelected}
            >
              {isSelected ? "▸" : " "}{" "}
              <Text bold={isSelected} color={isSelected ? theme.accent : theme.dim}>
                {idPart}
              </Text>{" "}
              <Text dimColor>{dateStr}</Text>{" "}
              <Text dimColor>· {s.steps} steps</Text>
            </Text>
            {/* Second row: task */}
            <Text
              dimColor={!isSelected}
              color={isSelected ? theme.user : undefined}
              bold={isSelected}
            >
              {isSelected ? "  " : "   "}
              {fit(s.task, 36)}
            </Text>
          </Box>
        );
      })}

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text dimColor>{"─".repeat(38)}</Text>
      </Box>
      <Text dimColor>
        ↑↓ / jk  navigate · enter select · esc close
      </Text>
      <Text dimColor>
        quick-jump: press 1-{Math.min(sessions.length, 9)} to jump
      </Text>
    </Box>
  );
}
