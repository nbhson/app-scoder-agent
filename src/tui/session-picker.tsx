/**
 * Session Picker Modal — keyboard-navigable list of saved sessions.
 *
 * Opens via "/" when the agent is idle (no task running).
 * ↑/↓ navigate, Enter select, Esc cancel.
 *
 * Shows: id (truncated), task, date, step count, build status.
 */
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { listSessions, type SessionSummary } from "../session/session.js";
import { theme, fit } from "./theme.js";
import { boxBorderStyle } from "./charset.js";
import { padEndCells, padStartCells } from "./text-width.js";

export interface SessionPickerProps {
  workdir: string;
  onSelect: (session: SessionSummary) => void;
  onClose: () => void;
}

const DISPLAY_LIMIT = 12;

export function SessionPicker({ workdir, onSelect, onClose }: SessionPickerProps): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState(0);
  const { rows, columns } = useWindowSize();

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

  // Improve TUI: panel full-width theo terminal (như Ctrl+P), hàng được căn
  // cột (id · date · steps · task) khi đủ rộng; chiều cao window theo rows để
  // picker không bao giờ tràn quá màn hình (selection luôn nằm trong cửa sổ).
  const cols = Math.max(46, columns ?? 100);
  const inner = cols - 4; // border 2 + paddingX 2
  const oneLine = inner >= 58; // ▸2 + id14 + sp + date16 + sp + steps≤10 — vừa ở 58
  const maxVisible = Math.max(3, Math.min(DISPLAY_LIMIT, Math.floor(((rows ?? 24) - 11) / (oneLine ? 1 : 2))));
  const winStart = Math.max(0, Math.min(selected - maxVisible + 1, Math.max(0, sessions.length - maxVisible)));
  const shown = sessions.slice(winStart, winStart + maxVisible);
  const rule = "─".repeat(inner);

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" width={cols} borderStyle={boxBorderStyle()} borderColor={theme.brand} paddingX={1} paddingY={1}>
        <Text color={theme.brand} bold>
          ← saved sessions
        </Text>
        <Text dimColor>no saved sessions found</Text>
        <Text dimColor>Esc to close</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={cols} borderStyle={boxBorderStyle()} borderColor={theme.brand} paddingX={1} paddingY={1}>
      {/* Header: title trái, count phải — span toàn chiều ngang */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={theme.brand} bold>
          ← saved sessions
        </Text>
        <Text dimColor>{sessions.length} session{sessions.length !== 1 ? "s" : ""}</Text>
      </Box>

      <Box>
        <Text dimColor>{rule}</Text>
      </Box>

      {/* Session list — một hàng/cửa sổ khi ≥70 cell, hai hàng khi hẹp */}
      {shown.map((s, j) => {
        const i = winStart + j;
        const isSelected = i === selected;
        const idPart = s.id.slice(0, 14);
        const dateStr = s.updatedAt ? s.updatedAt.slice(0, 16).replace("T", " ") : "—";
        if (oneLine) {
          const stepsTxt = `${s.steps} steps`;
          const taskBudget = Math.max(12, inner - 2 - 14 - 1 - 16 - 1 - stepsTxt.length - 1);
          return (
            <Text key={s.id} wrap="truncate">
              <Text color={isSelected ? theme.brand : theme.dim}>{isSelected ? "▸ " : "  "}</Text>
              <Text bold={isSelected} color={isSelected ? theme.accent : theme.dim}>{padEndCells(idPart, 14)}</Text>
              <Text dimColor>{" "}{padEndCells(dateStr, 16)}{" "}</Text>
              <Text dimColor>{padStartCells(stepsTxt, 9)} </Text>
              <Text dimColor={!isSelected} color={isSelected ? theme.user : undefined} bold={isSelected} wrap="truncate">
                {fit(s.task, taskBudget)}
              </Text>
            </Text>
          );
        }
        return (
          <Box key={s.id} flexDirection="column">
            <Text color={isSelected ? theme.brand : theme.dim} bold={isSelected} dimColor={!isSelected} wrap="truncate">
              {isSelected ? "▸" : " "}{" "}
              <Text bold={isSelected} color={isSelected ? theme.accent : theme.dim}>
                {idPart}
              </Text>{" "}
              <Text dimColor>{dateStr}</Text>{" "}
              <Text dimColor>· {s.steps} steps</Text>
            </Text>
            <Text dimColor={!isSelected} color={isSelected ? theme.user : undefined} bold={isSelected} wrap="truncate">
              {isSelected ? "  " : "   "}
              {fit(s.task, Math.max(12, inner - 4))}
            </Text>
          </Box>
        );
      })}
      {sessions.length > winStart + maxVisible && (
        <Text dimColor>  ⋯ +{sessions.length - winStart - maxVisible} more — ↓ to browse</Text>
      )}

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text dimColor>{rule}</Text>
      </Box>
      <Text dimColor>
        Up/Down or jk  navigate · Enter select · Esc close · quick-jump 1-{Math.min(sessions.length, 9)}
      </Text>
    </Box>
  );
}
