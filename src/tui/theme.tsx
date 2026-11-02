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
}

const MISSION: Theme = {
  brand: "magenta",
  accent: "cyan",
  success: "green",
  error: "red",
  warn: "yellow",
  user: "blue",
  dim: "gray",
  border: "gray",
};

const PAPER: Theme = {
  brand: "blue",
  accent: "blue",
  success: "green",
  error: "red",
  warn: "yellow",
  user: "black",
  dim: "gray",
  border: "gray",
};

const MONO: Theme = {
  brand: "white",
  accent: "white",
  success: "white",
  error: "white",
  warn: "white",
  user: "white",
  dim: "gray",
  border: "gray",
};

// T8: theme pack mở rộng — light/high-contrast/solarized (16-color names,
// degrade đúng trên terminal không đủ màu).
const LIGHT: Theme = {
  brand: "magentaBright",
  accent: "cyanBright",
  success: "greenBright",
  error: "redBright",
  warn: "yellowBright",
  user: "blueBright",
  dim: "blackBright",
  border: "blackBright",
};

const HIGH_CONTRAST: Theme = {
  brand: "whiteBright",
  accent: "cyanBright",
  success: "greenBright",
  error: "redBright",
  warn: "yellowBright",
  user: "whiteBright",
  dim: "white",
  border: "white",
};

const SOLARIZED: Theme = {
  brand: "magentaBright", // magenta
  accent: "cyanBright", // cyan
  success: "greenBright", // green
  error: "redBright", // red/orange
  warn: "yellowBright", // yellow
  user: "blueBright", // blue
  dim: "gray", // base01
  border: "gray",
};

export const THEMES: Record<string, Theme> = {
  mission: MISSION,
  paper: PAPER,
  mono: MONO,
  light: LIGHT,
  "high-contrast": HIGH_CONTRAST,
  solarized: SOLARIZED,
};

/**
 * T8: theme mặc định theo terminal caps — terminal không hỗ trợ 256color
 * (TERM=dumb, COLOR_COUNT thấp) dùng mono để degrade an toàn.
 */
export function defaultThemeName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TERM === "dumb" || !env.TERM) return "mono";
  if (env.COLOR_COUNT && Number(env.COLOR_COUNT) < 16) return "mono";
  return "mission";
}

/** Resolve theme: .scoder/theme.json (name or inline colors) > terminal-caps default. */
export function getTheme(workdir: string): Theme {
  const p = join(workdir, ".scoder", "theme.json");
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { name?: string } & Partial<Theme>;
      const base = raw.name ? THEMES[raw.name] ?? THEMES[defaultThemeName()] : THEMES[defaultThemeName()];
      return { ...base, ...Object.fromEntries(Object.entries(raw).filter(([k]) => k in base)) } as Theme;
    } catch {
      // malformed theme.json → default (never crash the TUI over a color)
    }
  }
  return THEMES[defaultThemeName()];
}

/** Current active theme — set at TUI mount (module-level for easy imports). */
let active: Theme = MISSION;

export function setActiveTheme(t: Theme): void {
  active = t;
}

/** Hot-swap theme name at runtime (/theme). Returns a notice. */
export function useNamedTheme(name: string): string {
  // T8: "/theme list" — liệt kê kèm mô tả ngắn.
  if (name === "list") {
    return `themes: ${Object.keys(THEMES).join(", ")} — /theme <name> để chuyển; project default qua .scoder/theme.json`;
  }
  const t = THEMES[name];
  if (!t) return `ERROR: unknown theme "${name}" — available: ${Object.keys(THEMES).join(", ")}`;
  active = t;
  return `theme → ${name}`;
}

export const theme = new Proxy({} as Theme, {
  get(_t, prop: string) {
    return (active as unknown as Record<string, unknown>)[prop];
  },
});

/** Icon per tool name — compact visual vocabulary for the flight recorder. */
const TOOL_ICONS: Record<string, string> = {
  list_files: "🗂",
  read_file: "📖",
  write_file: "📝",
  edit_file: "✏️",
  run_command: "⚡",
  web_fetch: "🌐",
  write_todos: "☑",
};

export function toolIcon(name: string): string {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name.startsWith("mcp__")) return "🔌";
  return "🔧";
}

/** Truncate to max chars (suffix ellipsis), keeping a single line. */
export function fit(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

/** The agent's signature mark, used as an avatar on assistant output. */
export function AgentMark(): React.JSX.Element {
  return <Text color={theme.brand} bold>◆ </Text>;
}
