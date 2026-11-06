/**
 * T2: chrome components — BuildRail, PhaseBreadcrumb, LiveMetrics,
 * GuardrailNotice, StatusBar. Tách khỏi app.tsx.
 */
import React from "react";
import { Box, Text, useWindowSize } from "ink";
import type { AgentConfig } from "../config.js";
import type { TuiState } from "./state.js";
import { fit, theme } from "./theme.js";
import { Spinner } from "./chat-views.js";
import { getVersion } from "../shared/version.js";

/** Fuel gauge is scaled to this many cells regardless of maxSteps. */
export const GAUGE_CELLS = 12;

/** Sidebar phải: tổng rộng (kể cả border + padding) — pattern opencode. */
export const SIDEBAR_WIDTH = 40;
/** Dưới ngưỡng cột này ẩn sidebar — BuildRail fallback sang header đầy đủ. */
export const SIDEBAR_MIN_COLS = 92;

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
export function BuildRail({ state, config }: { state: TuiState; config: AgentConfig }): React.JSX.Element {
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
    <Box
      borderStyle="bold"
      borderColor={theme.border}
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
          <Text dimColor>ready</Text>
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
 * Right: scroll position OR keyboard hints.
 */
export function StatusBar({ state, scroll }: { state: TuiState; scroll?: string | null }): React.JSX.Element {
  const { columns } = useWindowSize();
  const width = Math.max(40, (columns ?? 100) - 6);

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

  // Right side: scroll position OR helpful keybinds
  const rightText = scroll
    ? `scroll ${scroll} · esc→tail`
    : `⏎ send · ctrl+s sessions · ctrl+t ${state.thinkingVisible ? "◉" : "○"} · esc abort · ctrl+c quit`;

  const leftBudget = Math.max(24, width - rightText.length - 3);
  let left = statusLabel;
  if (model && model !== "—") {
    const part = ` · ${model}`;
    if (left.length + part.length <= leftBudget) left += part;
    else left = fit(left, leftBudget);
  }

  return (
    <Box
      borderStyle="bold"
      borderColor={theme.border}
      paddingX={1}
      justifyContent="space-between"
      alignItems="center"
      flexShrink={0}
    >
      {/* Left: status icon (spinner when running) + status label */}
      <Text>
        {state.status === "running" && <Spinner active />}
        {state.status === "running" ? "  " : statusIcon ? `${statusIcon} ` : "   "}
        <Text color={statusColor} bold>{left}</Text>
      </Text>
      {/* Right: hints */}
      <Text dimColor>{fit(rightText, Math.floor(width * 0.5))}</Text>
    </Box>
  );
}
