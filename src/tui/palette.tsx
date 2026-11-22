/**
 * Command palette (Ctrl+P) — interactive, fuzzy-searchable action list.
 *
 * Replaces the old static dump (SLASH_COMMANDS.slice(0,40) rendered with
 * padEnd — which violated the text-width display-string rule). One search
 * line over grouped actions: slash commands + custom commands + agents +
 * themes + permission modes + open-actions (session picker). Enter invokes
 * through the SAME submit path as typing the command (registry gates apply).
 *
 * Model building + ranking are pure (exported for unit tests); the component
 * only wires keys and renders. While open the palette owns the keyboard —
 * TuiApp routes Input/keybinds off via the overlay ref.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import fuzzysort from "fuzzysort";
import {
  BUILTIN_COMMANDS,
  PERMISSION_CYCLE,
  type CommandDef,
  type CustomCommand,
} from "../commands/definitions.js";
import { boxBorderStyle, charset } from "./charset.js";
import { THEMES, theme } from "./theme.js";
import { clipCells, measure } from "./text-width.js";

export type PaletteInvoke =
  | { kind: "submit"; text: string }
  | { kind: "action"; action: "sessions" };

export interface PaletteItem {
  group: string;
  label: string;
  desc: string;
  invoke: PaletteInvoke;
}

export interface PaletteSources {
  /** Builtin slash-command catalog (defaults to BUILTIN_COMMANDS). */
  commands?: CommandDef[];
  custom?: CustomCommand[];
  agents?: string[];
  themes?: string[];
  permissions?: string[];
}

const LIMIT = 14;

/** Grouped action catalog — every entry is a runnable command line. */
export function buildPaletteItems(sources: PaletteSources): PaletteItem[] {
  const out: PaletteItem[] = [];
  out.push({
    group: "ACTIONS",
    label: "Open saved sessions…",
    desc: "resume a previous session (Ctrl+S)",
    invoke: { kind: "action", action: "sessions" },
  });
  for (const c of sources.commands ?? BUILTIN_COMMANDS) {
    if (c.visibility === "hidden") continue;
    out.push({
      group: "COMMANDS",
      label: c.name,
      desc: c.description,
      invoke: { kind: "submit", text: c.usage.split(" ")[0] },
    });
  }
  for (const c of sources.custom ?? []) {
    if (c.visibility === "hidden") continue;
    out.push({
      group: "CUSTOM",
      label: `/${c.name}`,
      desc: c.description,
      invoke: { kind: "submit", text: `/${c.name}` },
    });
  }
  for (const a of sources.agents ?? []) {
    out.push({
      group: "AGENTS",
      label: `agent: ${a}`,
      desc: "switch primary agent (Shift+Tab cycles)",
      invoke: { kind: "submit", text: `/agent ${a}` },
    });
  }
  for (const t of sources.themes ?? Object.keys(THEMES)) {
    out.push({
      group: "THEMES",
      label: `theme: ${t}`,
      desc: "switch palette",
      invoke: { kind: "submit", text: `/theme ${t}` },
    });
  }
  for (const p of sources.permissions ?? PERMISSION_CYCLE) {
    out.push({
      group: "PERMISSION",
      label: `permission: ${p}`,
      desc: "auto / ask / readonly",
      invoke: { kind: "submit", text: `/permission ${p}` },
    });
  }
  return out;
}

/** Fuzzy rank (label weighted 1.0, desc 0.2); empty query keeps group order.
 *  This fuzzysort build returns `{target, score}` without `index`, so hits are
 *  mapped back through target strings (labels are unique; shared descriptions
 *  score their items equally — group order breaks the tie). */
export function rankPaletteItems(items: PaletteItem[], query: string, limit = LIMIT): PaletteItem[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit);
  const first = (rs: ReadonlyArray<{ target: string; score: number }>) => {
    const m = new Map<string, number>();
    for (const r of rs) if (!m.has(r.target)) m.set(r.target, r.score);
    return m;
  };
  const labelHits = first(fuzzysort.go(q, items.map((it) => it.label), { limit: 50 }));
  const descHits = first(fuzzysort.go(q, items.map((it) => it.desc), { limit: 50 }));
  return items
    .map((it, i) => ({
      it,
      i,
      score: (labelHits.get(it.label) ?? 0) + 0.2 * (descHits.get(it.desc) ?? 0),
      hit: labelHits.has(it.label) || descHits.has(it.desc),
    }))
    .filter((r) => r.hit)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.it);
}

export interface PaletteProps {
  agents: string[];
  custom: CustomCommand[];
  onInvoke: (inv: PaletteInvoke) => void;
  onClose: () => void;
}

export function Palette({ agents, custom, onInvoke, onClose }: PaletteProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const items = useMemo(() => buildPaletteItems({ agents, custom }), [agents, custom]);
  const shown = useMemo(() => rankPaletteItems(items, query), [items, query]);
  const selSafe = shown.length > 0 ? Math.min(sel, shown.length - 1) : 0;

  const move = useCallback((d: number) => setSel((s) => Math.max(0, Math.min(Math.max(0, shown.length - 1), s + d))), [shown.length]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      const it = shown[selSafe];
      if (it) onInvoke(it.invoke);
      return;
    }
    if (key.upArrow || input === "k" && !key.ctrl && !key.meta && query === "") {
      move(-1);
      return;
    }
    if (key.downArrow || input === "j" && !key.ctrl && !key.meta && query === "") {
      move(1);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSel(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab && input.length <= 8) {
      setQuery((q) => q + input.replace(/[\r\n]+$/, ""));
      setSel(0);
    }
  });

  // group headers follow the ranked order (items of a group render together)
  const rows: React.ReactNode[] = [];
  let lastGroup = "";
  shown.forEach((it, i) => {
    if (it.group !== lastGroup) {
      lastGroup = it.group;
      rows.push(
        <Text key={`g-${it.group}-${i}`} color={theme.brand} bold dimColor>
          {" "}
          {it.group}
        </Text>,
      );
    }
    const selected = i === selSafe;
    rows.push(
      <Text key={`${it.group}-${it.label}-${i}`}>
        <Text color={theme.brand}>{selected ? charset.active : " "} </Text>
        <Text bold={selected} color={selected ? theme.accent : undefined}>{clipCells(it.label, 22)}</Text>
        <Text dimColor>{"  "}{clipCells(it.desc, Math.max(10, 60 - measure(it.label)))}</Text>
      </Text>,
    );
  });

  return (
    <Box flexDirection="column" borderStyle={boxBorderStyle()} borderColor={theme.accent} paddingX={1} flexShrink={0}>
      <Text>
        <Text color={theme.accent} bold>⌕ </Text>
        <Text>{query}</Text>
        <Text color={theme.accent} bold>▌</Text>
        {query === "" && <Text dimColor>  search commands, agents, themes…</Text>}
        <Text dimColor>   {shown.length}/{items.length}</Text>
      </Text>
      {rows.length === 0 ? (
        <Text dimColor>  no matches — Esc to close</Text>
      ) : (
        rows
      )}
      <Text dimColor>Up/Down select · Enter run · Esc close · typing filters</Text>
    </Box>
  );
}
