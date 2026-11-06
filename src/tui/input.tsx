/**
 * T2: Input component — ↑/↓ history, Tab slash-command completion, @ fuzzy
 * file autocomplete, ghost text. Tách khỏi app.tsx.
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentConfig } from "../config.js";
import type { Agent } from "../agent.js";
import { applySuggestion, atQuery, fileIndex, suggest } from "./at-complete.js";
import { completeSlashCommand, completionProviders, ghostText, completeMcpArg } from "../commands/definitions.js";
import { applyNormalKey, type VimMode } from "./vim.js"; // T5
import { theme } from "./theme.js";

export interface InputProps {
  /** Source of truth — updated synchronously by the parent (submit clears it
   *  before the next keystroke can arrive, so chunks never merge across a
   *  keystroke + submit boundary). */
  valueRef: React.MutableRefObject<string>;
  /** Render mirror of valueRef.current. */
  value: string;
  onChange: (v: string) => void;
  /** Called with the final value (handles paste-with-newline chunks too). */
  onSubmit: (value: string) => void;
  /** Sent-message history for ↑/↓ recall. */
  historyRef: React.MutableRefObject<string[]>;
  /** Skill names for "/skill <Tab>" argument completion. */
  skillNames: string[];
  /** Agent ref — /mcp Tab completion reads mcpStatus() lazily (servers + tools). */
  agentRef: React.MutableRefObject<Agent | null>;
  /** Workdir for the @ file index (T-01). */
  config: AgentConfig;
  /** T-02: completion sources (skills/agents/files). */
  atSources: { skills: string[]; agents: string[]; files: string[] };
  /** T-03: when set, the permission modal owns the keyboard. */
  modalRef: React.MutableRefObject<unknown>;
}

export function Input({ valueRef, value, onChange, onSubmit, historyRef, skillNames, agentRef, config, atSources, modalRef }: InputProps): React.JSX.Element {
  const histIdx = useRef<number | null>(null);
  const draft = useRef<string>("");

  // ── T5: vim normal/insert mode ──
  // Insert là mode mặc định (chat input); Esc → normal, i/a/A → insert.
  // Cursor position chỉ có ý nghĩa khi normal mode; insert luôn ở cuối.
  const [vimMode, setVimMode] = useState<VimMode>("insert");
  const [cursor, setCursor] = useState<number | null>(null); // null = insert (cuối)
  const vimRef = useRef<{ mode: VimMode; cursor: number }>({ mode: "insert", cursor: 0 });
  vimRef.current = { mode: vimMode, cursor: cursor ?? value.length };

  // ── T-01: `@` fuzzy file autocomplete ──────────────────────────────────────
  // Overlay state kept out of React re-render hot path: suggestions are sync
  // (fuzzysort over cached index ≤5s TTL) so we can compute inside useInput.
  const [atState, setAtState] = useState<{ at: { start: number; query: string }; suggestions: string[]; idx: number } | null>(null);
  const atStateRef = useRef(atState);
  const workdir = config?.workdir ?? process.cwd();
  const refreshAt = useCallback(
    (v: string) => {
      const at = atQuery(v);
      if (!at) {
        if (atStateRef.current) {
          atStateRef.current = null;
          setAtState(null);
        }
        return;
      }
      const suggestions = suggest(fileIndex(workdir), at.query);
      const prev = atStateRef.current;
      // Keep selection when the query narrows (still points at same entry).
      const idx = prev && prev.at.start === at.start && suggestions[prev.idx] === prev.suggestions[prev.idx] ? prev.idx : 0;
      const next = suggestions.length > 0 ? { at, suggestions, idx } : null;
      atStateRef.current = next;
      setAtState(next);
    },
    [workdir],
  );
  const acceptAt = useCallback(
    (sel: string | undefined) => {
      const st = atStateRef.current;
      if (!st || sel === undefined) return;
      const v = applySuggestion(valueRef.current, st.at, sel);
      valueRef.current = v;
      onChange(v);
      atStateRef.current = null;
      setAtState(null);
    },
    [onChange, valueRef],
  );

  useInput(
    (input, key) => {
      if (modalRef.current) return; // T-03: modal owns the keyboard
      const current = valueRef.current;
      // T5: vim mode — Esc → normal (nếu không có @ overlay), normal keys qua keymap.
      if (key.escape && !atStateRef.current) {
        setCursor(vimRef.current.cursor);
        setVimMode("normal");
        return;
      }
      if (vimRef.current.mode === "normal" && input.length === 1 && !key.ctrl && !key.meta) {
        const r = applyNormalKey(current, vimRef.current.cursor, input);
        if (!r.unhandled) {
          valueRef.current = r.value;
          onChange(r.value);
          setCursor(r.cursor);
          setVimMode(r.mode);
          return;
        }
        if (key.return) {
          setVimMode("insert");
          setCursor(null);
          histIdx.current = null;
          onSubmit(current);
          return;
        }
        // Phím lạ trong normal mode (mũi tên, ctrl...) — fall through với
        // cursor giữ nguyên, xử lý như insert bên dưới.
      } else if (vimRef.current.mode === "normal") {
        return; // normal mode bỏ qua paste chunks
      }
      // T-01: Esc closes the @ overlay (before submit semantics).
      if (key.escape) {
        if (atStateRef.current) {
          atStateRef.current = null;
          setAtState(null);
        }
        return;
      }
      if (key.return) {
        histIdx.current = null;
        onSubmit(current);
        return;
      }
      // ↑/↓ message history recall — but T-01 @ overlay takes precedence.
      if (key.upArrow || key.downArrow) {
        if (atStateRef.current) {
          const st = atStateRef.current;
          const idx = key.upArrow ? Math.max(0, st.idx - 1) : Math.min(st.suggestions.length - 1, st.idx + 1);
          const next = { ...st, idx };
          atStateRef.current = next;
          setAtState(next);
          return;
        }
        const hist = historyRef.current;
        if (hist.length === 0) return;
        if (histIdx.current === null) {
          if (key.downArrow) return;
          draft.current = current;
          histIdx.current = hist.length - 1;
        } else if (key.upArrow) {
          histIdx.current = Math.max(0, histIdx.current - 1);
        } else {
          histIdx.current += 1;
          if (histIdx.current >= hist.length) {
            histIdx.current = null;
            onChange(draft.current);
            valueRef.current = draft.current;
            return;
          }
        }
        const v = hist[histIdx.current];
        valueRef.current = v;
        onChange(v);
        return;
      }
      // Tab — complete slash command (and /skill, /mcp arguments)
      if (key.tab) {
        const argMatch = /^\/skill\s+(\S*)$/.exec(current);
        if (argMatch) {
          const partial = argMatch[1].toLowerCase();
          const hits = skillNames.filter((n) => n.toLowerCase().startsWith(partial));
          if (hits.length > 0) {
            const v = "/skill " + hits[0] + (hits.length === 1 ? " " : "");
            valueRef.current = v;
            onChange(v);
          }
          return;
        }
        if (/^\/mcp\s/.test(current)) {
          // /mcp completion cần danh sách server/tools — async qua mcpStatus().
          const agent = agentRef.current;
          if (agent) {
            void agent.mcpStatus().then((servers) => {
              const v = completeMcpArg(current, servers);
              if (v) {
                valueRef.current = v;
                onChange(v);
              }
            });
          }
          return;
        }
        // T-02: Tab accepts ghost text (unique candidate extension).
        if (!atStateRef.current && ghostRef.current) {
          const v = ghostRef.current.insert;
          valueRef.current = v;
          onChange(v);
          return;
        }
        // T-01: Tab accepts the active @ suggestion (dirs keep trailing slash).
        if (atStateRef.current) {
          acceptAt(atStateRef.current.suggestions[atStateRef.current.idx]);
          return;
        }
        const comp = completeSlashCommand(current);
        if (comp) {
          valueRef.current = comp.completed;
          onChange(comp.completed);
        }
        return;
      }
      if (key.backspace || key.delete) {
        const next = current.slice(0, -1);
        valueRef.current = next;
        onChange(next);
        refreshAt(next);
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta && !key.escape && !key.upArrow && !key.downArrow && !key.tab) {
        // A chunk may contain several pasted chars — even a trailing newline
        // (terminal pastes / PTY writes deliver "exit\r" as one chunk).
        const parts = input.split(/[\r\n]+/);
        const next = current + parts[0];
        valueRef.current = next;
        onChange(next);
        refreshAt(next);
        if (parts.length > 1) onSubmit(next); // newline in the chunk = submit
      }
      // T5: bất kỳ phím gõ nào trong insert mode cũng đưa cursor về cuối.
      if (vimRef.current.mode === "insert") setCursor(null);
    },
    // Always active: typing while the agent runs is allowed (text is kept,
    // submit is a no-op until idle) so keystrokes are never silently lost.
  );

  // Live candidates hint while a slash command is partially typed.
  const hint = value.startsWith("/") && !value.includes(" ") ? completeSlashCommand(value) : null;
  const candidates = hint && hint.candidates.length > 1 ? hint.candidates.map((c) => c.cmd).join("  ") : null;
  const at = atState;
  // T-02 ghost text: unique extension of the last token, dim after cursor.
  const providers = useMemo(() => completionProviders(atSources), [atSources]);
  const ghost = useMemo(() => (atState ? null : ghostText(value, providers)), [value, providers, atState]);
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  return (
    <Box flexDirection="column">
      {at && (
        <Box flexDirection="column" paddingLeft={2}>
          {at.suggestions.map((s, i) => (
            <Text key={s} color={i === at.idx ? theme.brand : undefined} bold={i === at.idx}>
              {i === at.idx ? "▸ " : "  "}
              {s}
            </Text>
          ))}
          <Text dimColor>  ↑/↓ select · tab/enter accept · esc close</Text>
        </Box>
      )}
      {/* Input row — styled prompt + typed text + ghost + block cursor */}
      <Box>
        <Text color={theme.brand} bold>
          ❯{" "}
        </Text>
        {vimMode === "normal" && cursor !== null ? (
          <>
            <Text>{value.slice(0, cursor)}</Text>
            <Text backgroundColor="gray" color="black">{value[cursor] ?? " "}</Text>
            <Text>{value.slice(cursor + 1)}</Text>
          </>
        ) : value.length === 0 ? (
          <>
            <Text dimColor>type a message…</Text>
            <Text dimColor>▌</Text>
          </>
        ) : (
          <>
            <Text>{value}</Text>
            {ghost && <Text dimColor>{ghost.rest}</Text>}
            <Text dimColor>▌</Text>
          </>
        )}
      </Box>
      {candidates && <Text dimColor>  {candidates}  (tab completes)</Text>}
      {vimMode === "normal" && <Text dimColor>  -- NORMAL -- h/l/w/b/e · x · i/a/A insert · ⏎ send</Text>}
    </Box>
  );
}
