/**
 * T2: chrome components — BuildRail, PhaseBreadcrumb, LiveMetrics,
 * GuardrailNotice, StatusBar. Tách khỏi app.tsx.
 */
import React from "react";
import { Box, Text, useWindowSize } from "ink";
import type { AgentConfig } from "../config.js";
import { contextWindowFor } from "../model-catalog.js";
import { resolveModelPricing } from "../constants.js";
import type { TuiState } from "./state.js";
import { fit, theme } from "./theme.js";
import { Spinner } from "./chat-views.js";

/** Fuel gauge is scaled to this many cells regardless of maxSteps. */
const GAUGE_CELLS = 10;

/** Scaled step fuel gauge: ▰ filled / ▱ remaining, e.g. ▰▰▰▰▱▱▱▱ 4/40. */
export function fuelGauge(step: number, maxSteps: number): string | null {
  if (maxSteps <= 0) return null;
  const filled = Math.min(GAUGE_CELLS, Math.round((Math.min(step, maxSteps) / maxSteps) * GAUGE_CELLS));
  return "▰".repeat(filled) + "▱".repeat(GAUGE_CELLS - filled);
}

/** T-11: gauge segment color — green (headroom) → yellow → red (nearly spent). */
function gaugeColor(step: number, maxSteps: number): string {
  const ratio = maxSteps > 0 ? Math.min(step, maxSteps) / maxSteps : 0;
  return ratio < 0.6 ? theme.success : ratio < 0.85 ? theme.warn : theme.error;
}

/** Build Rail — scoder's signature top bar: badges + lamp + fuel gauge. */
export function BuildRail({ state, config }: { state: TuiState; config: AgentConfig }): React.JSX.Element {
  const { columns } = useWindowSize();
  const width = Math.max(40, (columns ?? 100) - 6); // usable inner width
  const lampColor = state.buildLamp === "ok" ? theme.success : state.buildLamp === "fail" ? theme.error : theme.dim;
  const lampLabel = state.buildLamp === "ok" ? "build ok" : state.buildLamp === "fail" ? "build fail" : "no build yet";
  const gauge = fuelGauge(state.step, state.maxSteps);
  const gColor = gaugeColor(state.step, state.maxSteps);
  const perm = state.permission || config.permissionMode;
  const model = state.model || config.model || "—";

  const right = gauge ? `${gauge} ${state.step}/${state.maxSteps}` : "— idle";
  const lamp = `● ${lampLabel}`;
  // Hàng 1: brand · model | ⛨ perm · ● lamp | gauge. MCP chỉ đếm số (tên xem qua /mcp).
  const mcpNames = Object.keys(config.mcpServers ?? {});
  const mcpLabel = mcpNames.length > 0 ? ` · mcp×${mcpNames.length}` : "";
  const leftBudget = Math.max(8, width - right.length - lamp.length - 12);
  // Hàng phụ chỉ hiện khi run đang hoạt động — idle giữ nguyên một hàng (minimalism).
  const showSecondRow = state.status === "running" || state.phases.length > 0;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1} flexShrink={0}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={theme.brand}>scoder</Text>
          <Text dimColor> · {fit(model, Math.max(4, leftBudget - "scoder · ".length))}</Text>
          {mcpLabel && <Text color={theme.accent}>{mcpLabel}</Text>}
        </Text>
        <Text>
          <Text color={perm === "readonly" ? theme.warn : perm === "ask" ? theme.accent : theme.dim}>⛨ {perm}</Text>
          <Text> </Text>
          <Text color={lampColor}>{lamp}</Text>
        </Text>
        <Text>
          {gauge && (
            <>
              <Text color={gColor}>{gauge}</Text>
              <Text dimColor> {state.step}/{state.maxSteps}</Text>
            </>
          )}
          {!gauge && <Text dimColor>— idle</Text>}
        </Text>
      </Box>
      {showSecondRow && (
        <Box justifyContent="space-between">
          <PhaseBreadcrumb phases={state.phases} />
          <LiveMetrics state={state} />
        </Box>
      )}
      {showSecondRow && state.lastGuardrail && <GuardrailNotice text={state.lastGuardrail} />}
    </Box>
  );
}

/** Breadcrumb tiến trình: plan › explore › edit › build › verify. */
const PHASE_SEQUENCE = ["plan", "explore", "edit", "build", "verify"] as const;

function PhaseBreadcrumb({ phases }: { phases: string[] }): React.JSX.Element {
  const current = phases[phases.length - 1] ?? null;
  return (
    <Text>
      {PHASE_SEQUENCE.map((p, i) => {
        const visited = phases.includes(p);
        const isCurrent = p === current;
        return (
          <Text key={p}>
            {i > 0 && <Text dimColor> › </Text>}
            <Text color={isCurrent ? theme.accent : visited ? theme.success : theme.dim} bold={isCurrent}>
              {p}
            </Text>
          </Text>
        );
      })}
    </Text>
  );
}

/** Metrics sống bên phải breadcrumb: tokens (in/out · tok/s) · elapsed · guardrails. */
function LiveMetrics({ state }: { state: TuiState }): React.JSX.Element {
  const parts: string[] = [];
  if (state.usage.calls > 0) {
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    let tok = `tok ${fmt(state.usage.inputTokens)}→${fmt(state.usage.outputTokens)}`;
    // tok/s: output tokens / elapsed seconds của run.
    if (state.startedAt) {
      const s = ((state.endedAt ?? Date.now()) - state.startedAt) / 1000;
      if (s > 0.5) tok += ` · ${fmt(Math.round(state.usage.outputTokens / s))} tok/s`;
    }
    // T-11: context % — input tokens so với model context window (catalog).
    const win = contextWindowFor(state.provider, state.model);
    if (win > 0) {
      const pct = Math.round((state.usage.inputTokens / win) * 100);
      tok += ` · ctx ${pct}%`;
    }
    // T-11: cost estimate live (pricing từ models.dev bảng builtin).
    const cost =
      (state.usage.inputTokens / 1_000_000) * resolveModelPricing(state.model).input +
      (state.usage.outputTokens / 1_000_000) * resolveModelPricing(state.model).output;
    if (cost > 0) tok += ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
    parts.push(tok);
  }
  if (state.startedAt) {
    const s = Math.floor(((state.endedAt ?? Date.now()) - state.startedAt) / 1000);
    parts.push(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  }
  if (state.guardrailCount > 0) {
    parts.push(`guardrails ${state.guardrailCount}`);
  }
  if (parts.length === 0) return <Text dimColor>starting…</Text>;
  return <Text dimColor>{parts.join(" · ")}</Text>;
}

/** Guardrail can thiệp gần nhất — hàng riêng, văn bản tự giải thích, không nhồi vào hàng metrics. */
function GuardrailNotice({ text }: { text: string }): React.JSX.Element | null {
  return <Text color={theme.warn}>⚠ agent reminder: {text}</Text>;
}

export function StatusBar({ state, scroll }: { state: TuiState; scroll?: string | null }): React.JSX.Element {
  const { columns } = useWindowSize();
  const width = Math.max(40, (columns ?? 100) - 6);
  const statusColor = state.status === "running" ? theme.accent : state.status === "success" ? theme.success : state.status === "failed" ? theme.error : theme.dim;
  const statusLabel =
    state.status === "running" ? `running ${state.step}/${state.maxSteps}` : state.status === "idle" ? "idle" : state.status;
  const model = state.model || "—";
  // Left: status · elapsed · model. Right: scroll position or keybinds.
  // (Tokens live in the header metrics row only — no duplicated display here.)
  const keybinds = scroll ? `↑ scrollback ${scroll} · ⏎ send · ctrl+c quit` : `⏎ send · pgup history · ctrl+t thinking ${state.thinkingVisible ? "on" : "off"} · ctrl+c quit`;
  const leftBudget = Math.max(20, width - keybinds.length - 2);
  const elapsed = state.startedAt ? `${Math.floor((Date.now() - state.startedAt) / 60000)}:${String(Math.floor((Date.now() - state.startedAt) / 1000) % 60).padStart(2, "0")}` : null;
  let left = statusLabel + (state.status === "running" && elapsed ? ` · ${elapsed}` : "");
  const modelPart = ` · ${model}`;
  if (left.length + modelPart.length <= leftBudget) left += modelPart;
  else left = fit(left, leftBudget);
  return (
    <Box borderStyle="single" borderColor={theme.border} paddingX={1} justifyContent="space-between" flexShrink={0}>
      <Text>
        {state.status === "running" && <Spinner active />}
        {state.status === "running" ? " " : ""}
        <Text color={statusColor}>{left}</Text>
      </Text>
      <Text dimColor>{keybinds}</Text>
    </Box>
  );
}
