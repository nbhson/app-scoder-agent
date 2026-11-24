/**
 * T2: chrome components — BuildRail, PhaseBreadcrumb, LiveMetrics,
 * GuardrailNotice, StatusBar. Tách khỏi app.tsx.
 */
import React from "react";
import { Box, Text, useWindowSize } from "ink";
import type { AgentConfig } from "../config/config.js";
import type { TuiState } from "./state.js";
import { fit, theme } from "./theme.js";
import { compactMetrics, queueBadge } from "./metrics.js";
import { measure, clipCells } from "./text-width.js";
import { gitChip, type GitContext } from "../workspace/git-status.js";
import { Spinner } from "./chat-views.js";
import { getVersion } from "../shared/version.js";
import { dividerBorderStyle } from "./charset.js";

/** Fuel gauge is scaled to this many cells regardless of maxSteps. */
export const GAUGE_CELLS = 12;

/** Sidebar phải: tổng rộng (kể cả border + padding) — pattern opencode. */
export const SIDEBAR_WIDTH = 48;
/** Dưới ngưỡng cột này ẩn sidebar — BuildRail fallback sang header đầy đủ. */
export const SIDEBAR_MIN_COLS = 100;

/** Scaled step fuel gauge: ▰ filled / ▱ remaining, e.g. ▰▰▰▰▱▱▱▱ 4/40. */
export function fuelGauge(step: number, maxSteps: number): string | null {
  if (maxSteps <= 0) return null;
  const filled = Math.min(GAUGE_CELLS, Math.round((Math.min(step, maxSteps) / maxSteps) * GAUGE_CELLS));
  return "▰".repeat(filled) + "▱".repeat(GAUGE_CELLS - filled);
}

/** T-11: gauge segment color — green (headroom) → yellow → red (nearly spent). */
export function gaugeColor(step: number, maxSteps: number): string {
  const ratio = maxSteps > 0 ? Math.min(step, maxSteps) / maxSteps : 0;
  return ratio < 0.6 ? theme.success : ratio < 0.85 ? theme.warn : theme.error;
}

/**
 * BuildRail — polished top bar (SINGLE row).
 *
 * Layout:  [⚑ scoder] ── [phase breadcrumb / guardrail warning] ── [perm] [build]
 *
 * Terminal ≥ SIDEBAR_MIN_COLS: sidebar handles METRICS + PHASES.
 * Terminal < SIDEBAR_MIN_COLS: phase breadcrumb + metrics move into this row.
 */
export function BuildRail({ state, config, git = null }: { state: TuiState; config: AgentConfig; git?: GitContext | null }): React.JSX.Element {
  const { columns } = useWindowSize();
  const wide = (columns ?? 100) >= SIDEBAR_MIN_COLS;
  const perm = state.permission || config.permissionMode;
  const permColor = perm === "readonly" ? theme.warn : perm === "ask" ? theme.accent : theme.dim;

  // Build lamp
  const lampColor = state.buildLamp === "ok" ? theme.success : state.buildLamp === "fail" ? theme.error : theme.dim;
  const lampLabel = state.buildLamp === "ok" ? "✓" : state.buildLamp === "fail" ? "✗" : "○";
  const lampText = state.buildLamp === "ok" ? "ok" : state.buildLamp === "fail" ? "fail" : "—";

  // Guardrail: shown inline if it fired (small warning before the phase breadcrumb).
  const hasGuardrail = Boolean(state.lastGuardrail);

  // Guardrail text gets the whole center region — no fixed 40-char cap that
  // truncates while the header still has empty space. Reserve room for the
  // brand on the left and permission/build lamps on the right.
  const centerBudget = Math.max(24, (columns ?? 100) - 34);

  // Phase breadcrumb or narrow-terminal metrics (right of the center)
  const showNarrowMetrics = !wide && (state.status === "running" || state.phases.length > 0);

  return (
    // App-bar style: chỉ 1 divider mảnh dưới đáy thay vì khung "bold" nặng
    // 3 hàng — tiết kiệm 1 dòng dọc và cho cảm giác hiện đại hơn.
    <Box
      borderStyle={dividerBorderStyle()}
      borderColor={theme.border}
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      justifyContent="space-between"
      alignItems="center"
      flexShrink={0}
    >
      {/* Left: brand logo */}
      <Text bold color={theme.brand}>
        ⚑ <Text bold>scoder</Text><Text dimColor> (v{getVersion()})</Text>
      </Text>

      {/* Center: guardrail warning OR phase breadcrumb */}
      <Box flexGrow={1} justifyContent="center">
        {hasGuardrail ? (
          <Text color={theme.warn} bold>⚠ {fit(state.lastGuardrail!, centerBudget)}</Text>
        ) : state.status === "running" ? (
          showNarrowMetrics ? (
            <PhaseBreadcrumb phases={state.phases} />
          ) : (
            <Text dimColor>plan › explore › edit › build › verify</Text>
          )
        ) : (
          <Box gap={2}>
            <Text dimColor>ready</Text>
            {/* P7: branch + dirty count, idle only — the running rail keeps
                guardrail/breadcrumb priority (git lives in the StatusBar). */}
            {git != null && (
              <Text>
                <Text dimColor>⎇ {clipCells(git.branch, 24)}</Text>
                {git.dirty > 0 && <Text color={theme.warn}> · ±{git.dirty}</Text>}
              </Text>
            )}
          </Box>
        )}
      </Box>

      {/* Right: permission · build lamp (step count lives in the sidebar +
          bottom StatusBar — showing it here too was redundant). */}
      <Text>
        <Text color={permColor}>[{perm}]</Text>
        <Text> </Text>
        <Text color={lampColor}>{lampLabel}</Text>
        <Text dimColor> {lampText}</Text>
      </Text>
    </Box>
  );
}

/** Breadcrumb tiến trình: plan › explore › edit › build › verify. */
const PHASE_SEQUENCE = ["plan", "explore", "edit", "build", "verify"] as const;

/** Clean horizontal phase trail with separator dots (● visited, ○ pending, ◆ current). */
function PhaseBreadcrumb({ phases }: { phases: string[] }): React.JSX.Element {
  const current = phases[phases.length - 1] ?? null;
  return (
    <Text>
      {PHASE_SEQUENCE.map((p, i) => {
        const visited = phases.includes(p);
        const isCurrent = p === current;
        const dot = isCurrent ? "◆" : visited ? "●" : "○";
        return (
          <Text key={p}>
            {i > 0 && <Text dimColor> · </Text>}
            <Text color={isCurrent ? theme.accent : visited ? theme.success : theme.dim} bold={isCurrent}>
              {dot} {p}
            </Text>
          </Text>
        );
      })}
    </Text>
  );
}

/** Metrics cho narrow-terminal — không còn dùng (sidebar đã thay thế), giữ để tham khảo. */

/**
 * Status bar — bottom row. Left: spinner · status · elapsed · model.
 * Right: scroll position OR keyboard hints. In select mode (Ctrl+O) the hints
 * swap to the copy reminder — the mouse belongs to the terminal there.
 */
/** OSC 52 clipboard copy — best-effort (many terminals gate it; harmless). */
export function osc52Copy(text: string): boolean {
  if (process.stdout.isTTY !== true) return false;
  try {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    return true;
  } catch {
    return false;
  }
}

/**
 * One help row: `Key` in accent + what it does in dim, joined by ` · `.
 * Modifiers are spelled out (Ctrl+T, Shift+Tab) — the help panel is exactly
 * where ⌃/⇧ glyphs stop people. Presentational only (used by the ? overlay).
 */
export function HelpLine({ items }: { items: ReadonlyArray<readonly [string, string]> }): React.JSX.Element {
  return (
    <Text>
      {items.map(([key, what], i) => (
        <Text key={key}>
          {i > 0 && <Text dimColor> · </Text>}
          <Text bold color={theme.accent}>{key}</Text>
          <Text dimColor>{` ${what}`}</Text>
        </Text>
      ))}
    </Text>
  );
}

/** P2.2: tên tab KẾ TIẾP trong vòng Ctrl+B (mirror nextSidebarTab ở sidebar —
 *  không import chéo vì sidebar đã import module này). */
function nextTabHint(t: "overview" | "router" | "log"): string {
  return t === "log" ? "overview" : t === "router" ? "log" : "router";
}

/**
 * Bottom-bar key hints — modifiers spelled out ("Ctrl+B", "Shift+Tab", "Enter"),
 * never ⌃ ⇧ ⏎ ⇥ glyphs (they read as icons and are slow to scan). Ordered
 * most-needed first: `pickHints` drops whole hints from the tail when the
 * terminal is narrow, instead of clipping mid-word like `fit()` did.
 */
function hintSegments(sidebarTabLabel: string): string[] {
  return [
    "Enter send",
    "Esc abort",
    "Ctrl+C quit",
    `Ctrl+B ${sidebarTabLabel}`,
    "Ctrl+P palette",
    "Shift+Tab agent",
    "Shift+P perm",
    "Ctrl+T thinking",
    "? help",
  ];
}

/** Join ` · ` while the budget holds; always returns at least the first hint. */
export function pickHints(segs: string[], budget: number): string {
  let out = "";
  for (const s of segs) {
    const next = out ? `${out} · ${s}` : s;
    if (measure(next) > budget) break;
    out = next;
  }
  return out || fit(segs[0] ?? "", budget);
}

export function StatusBar({ state, scroll, selectMode = false, sidebarTab = "overview", git = null }: { state: TuiState; scroll?: string | null; selectMode?: boolean; sidebarTab?: "overview" | "router" | "log"; git?: GitContext | null }): React.JSX.Element {

  const { columns } = useWindowSize();
  const width = Math.max(40, (columns ?? 100) - 6);
  // Sidebar hidden → the metrics it would show must not vanish from the UI.
  const narrow = (columns ?? 100) < SIDEBAR_MIN_COLS;

  const statusColor =
    state.status === "running" ? theme.accent :
    state.status === "success" ? theme.success :
    state.status === "failed" ? theme.error :
    state.status === "aborted" ? theme.warn : theme.dim;

  // Status label only — step count (x/40) and elapsed time live in the
  // sidebar METRICS section, so they are intentionally NOT duplicated here.
  const statusLabel = state.status === "idle" ? "idle" : state.status;

  // Icon per status — fills the gap before the label (running keeps the
  // animated spinner; other states get a static, status-appropriate glyph).
  const statusIcon =
    state.status === "success" ? "✓" :
    state.status === "failed" ? "✗" :
    state.status === "aborted" ? "⚠" :
    state.status === "idle" ? "○" : null;

  const model = state.model || "—";

  // A3: steering/queue depth — data was already in state, nothing rendered it.
  const badge = queueBadge(state);

  // P7: while running (or when a guardrail owns the BuildRail center) the git
  // chip relocates HERE as its own dim node — the status color/bold must not
  // bleed into it. Decided before the hint line is built: the left side states
  // its preferred content first so a long spelled-out hint can never squeeze
  // the chip out of the bar (the old 0.62 cap let it eat the whole left side).
  const railShowsGit = git != null && state.status !== "running" && !state.lastGuardrail;
  let gitText = git && !railShowsGit ? gitChip(git) : null;
  const leftPreferred =
    measure(statusLabel) +
    (model !== "—" ? measure(` · ${model}`) : 0) +
    (gitText ? measure(` · ⎇ ${gitText}`) : 0) +
    (badge ? measure(badge) + 3 : 0);

  // Right side: select-mode reminder OR scroll position OR keybind hints.
  // Never more than 0.72 of the row, and never less than what the left needs.
  const metrics = narrow ? compactMetrics(state) : null;
  const rightBudget = Math.max(12, Math.min(Math.floor(width * 0.72), width - leftPreferred - 6));
  const rightText = selectMode
    ? pickHints(["select mode", "Ctrl+O back", "drag to highlight", "Cmd+C copies"], rightBudget)
    : scroll
      ? pickHints([`scroll ${scroll}`, "Esc to tail"], rightBudget)
      : metrics
        // sidebar hidden (<SIDEBAR_MIN_COLS): surface ctx/cost here instead.
        ? pickHints([metrics, "Ctrl+S sessions", "Esc abort"], rightBudget)
        : pickHints(hintSegments(nextTabHint(sidebarTab)), rightBudget);

  const leftBudget = Math.max(24, width - measure(rightText) - (badge ? measure(badge) + 3 : 3));
  let left = statusLabel;
  if (model && model !== "—") {
    const part = ` · ${model}`;
    if (measure(left) + part.length <= leftBudget) left += part;
    else left = fit(left, leftBudget);
  }
  // Dropped entirely when the left budget really is gone.
  if (gitText && measure(left) + measure(` · ⎇ ${gitText}`) > leftBudget) gitText = null;

  return (
    // App-bar style: chỉ 1 divider mảnh trên đỉnh, đối xứng với BuildRail.
    <Box
      borderStyle={dividerBorderStyle()}
      borderColor={theme.border}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      justifyContent="space-between"
      alignItems="center"
      flexShrink={0}
    >
      {/* Left: status icon (spinner when running) + status label (+ queue badge) */}
      <Text>
        {state.status === "running" && <Spinner active />}
        {state.status === "running" ? "  " : statusIcon ? `${statusIcon} ` : "   "}
        <Text color={statusColor} bold>{left}</Text>
        {gitText && <Text dimColor> · ⎇ {gitText}</Text>}
        {badge && <Text color={theme.accent}> {badge}</Text>}
      </Text>
      {/* Right: hints — pickHints already sized the line to the budget, so a
          whole hint disappears instead of "Ctrl+C qu…" when the terminal is
          narrow. Left (status+model) has its own leftBudget below. */}
      <Text dimColor>{rightText}</Text>
    </Box>
  );
}
