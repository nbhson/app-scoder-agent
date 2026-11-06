/**
 * TUI design system — theme engine (T-09).
 *
 * Three built-in palettes (mission / paper / mono) + user override via
 * .scoder/theme.json in the project. Ink color names only (16-color safe).
 * getTheme(workdir) resolves once per TUI mount — no hot reload (ponytail:
 * add FS-watch when a use-case appears).
 */
import React from "react";
import { Text } from "ink";
import { clipCells } from "./text-width.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Theme {
  brand: string;
  accent: string;
  success: string;
  error: string;
  warn: string;
  user: string;
  dim: string;
  border: string;
  // ── T-15: display enhancement tokens ──────────────────────────────────────
  mermaid: string;  // mermaid diagram accent (purple)
  thinking: string; // reasoning/thinking blocks
  code: string;     // inline code + syntax highlight base
  table: string;    // table header accent
}

const MISSION: Theme = {
  brand: "magenta", accent: "cyan", success: "green", error: "red", warn: "yellow",
  user: "blue", dim: "gray", border: "gray",
  mermaid: "magentaBright", thinking: "gray", code: "green", table: "cyan",
};

const PAPER: Theme = {
  brand: "blue", accent: "blue", success: "green", error: "red", warn: "yellow",
  user: "black", dim: "gray", border: "gray",
  mermaid: "magentaBright", thinking: "gray", code: "green", table: "cyan",
};

const MONO: Theme = {
  brand: "white", accent: "white", success: "white", error: "white", warn: "white",
  user: "white", dim: "gray", border: "gray",
  mermaid: "whiteBright", thinking: "white", code: "whiteBright", table: "whiteBright",
};

const LIGHT: Theme = {
  brand: "magentaBright", accent: "cyanBright", success: "greenBright", error: "redBright",
  warn: "yellowBright", user: "blueBright", dim: "blackBright", border: "blackBright",
  mermaid: "magentaBright", thinking: "gray", code: "greenBright", table: "cyanBright",
};

const HIGH_CONTRAST: Theme = {
  brand: "whiteBright", accent: "cyanBright", success: "greenBright", error: "redBright",
  warn: "yellowBright", user: "whiteBright", dim: "white", border: "whiteBright",
  mermaid: "magentaBright", thinking: "whiteBright", code: "greenBright", table: "cyanBright",
};

const SOLARIZED: Theme = {
  brand: "magentaBright", accent: "cyanBright", success: "greenBright", error: "redBright",
  warn: "yellowBright", user: "blueBright", dim: "gray", border: "gray",
  mermaid: "magentaBright", thinking: "gray", code: "greenBright", table: "cyanBright",
};

export const THEMES: Record<string, Theme> = {
  mission: MISSION, paper: PAPER, mono: MONO,
  light: LIGHT, "high-contrast": HIGH_CONTRAST, solarized: SOLARIZED,
};

export function defaultThemeName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SCODER_THEME && THEMES[env.SCODER_THEME]) return env.SCODER_THEME;
  if (env.SCODER_PLAIN === "1" || env.NO_COLOR === "1" || process.env.NO_COLOR === "1") return "mono";
  if (env.TERM === "dumb" || !env.TERM) return "mono";
  if (env.COLOR_COUNT && Number(env.COLOR_COUNT) < 16) return "mono";
  return "mission";
}

export function getTheme(workdir: string): Theme {
  const p = join(workdir, ".scoder", "theme.json");
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { name?: string } & Partial<Theme>;
      const base = raw.name ? THEMES[raw.name] ?? THEMES[defaultThemeName()] : THEMES[defaultThemeName()];
      return { ...base, ...Object.fromEntries(Object.entries(raw).filter(([k]) => k in base)) } as Theme;
    } catch { /* malformed → default */ }
  }
  return THEMES[defaultThemeName()];
}

let active: Theme = MISSION;
export function setActiveTheme(t: Theme): void { active = t; }

export function useNamedTheme(name: string): string {
  if (name === "list") return `themes: ${Object.keys(THEMES).join(", ")} — /theme <name>`;
  const t = THEMES[name];
  if (!t) return `ERROR: unknown theme "${name}" — available: ${Object.keys(THEMES).join(", ")}`;
  active = t;
  return `theme → ${name}`;
}

export const theme = new Proxy({} as Theme, {
  get(_t, prop: string) { return (active as unknown as Record<string, unknown>)[prop]; },
});

/** Icon per tool name — compact visual vocabulary for the flight recorder. */
const TOOL_ICONS: Record<string, string> = {
  list_files: "🗂", read_file: "📖", write_file: "📝", edit_file: "✏️",
  run_command: "⚡", web_fetch: "🌐", write_todos: "☑",
};

export function toolIcon(name: string): string {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name.startsWith("mcp__")) return "🔌";
  return "🔧";
}

export function fit(text: string, max: number): string {
  return clipCells(text, max);
}

/** The agent's signature mark, used as an avatar on assistant output. */
export function AgentMark(): React.JSX.Element {
  return <Text color={theme.brand} bold>◆ </Text>;
}
