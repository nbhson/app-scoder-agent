/**
 * Sidebar bên phải (pattern opencode) — "mission control" panel: session,
 * plan live, metrics (tok/s · ctx · cost), phases, build lamp, MCP servers.
 *
 * Tách khỏi chat transcript để chat sạch và trạng thái luôn nhìn thấy mà
 * không cần scroll. Ẩn hoàn toàn trên terminal hẹp (< SIDEBAR_MIN_COLS) —
 * khi đó BuildRail fallback sang header đầy đủ (chrome.tsx).
 * (Guardrail notice trước đây nằm cuối sidebar — đã chuyển lên header, căn giữa.)
 */
import React from "react";
import { Box, Text } from "ink";
import type { AgentConfig } from "../config.js";
import { contextWindowFor } from "../model-catalog.js";
import { resolveModelPricing } from "../constants.js";
import { latestPlan, type ChatItem, type TuiState } from "./state.js";
import { fit, theme } from "./theme.js";
import { fuelGauge, gaugeColor, SIDEBAR_WIDTH } from "./chrome.js";

const INNER = SIDEBAR_WIDTH - 4; // border + paddingX
const MAX_PLAN_ROWS = 14; // cap chiều cao — plan dài thì gộp "+N more"

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Text dimColor bold>─ {title}</Text>
      {children}
    </Box>
  );
}

function SectionLine({ label, value, color }: { label: string; value: string; color?: string }): React.JSX.Element {
  return (
    <Text wrap="truncate">
      <Text dimColor>  {fit(label, 8)} </Text>
      <Text color={color}>{value}</Text>
    </Text>
  );
}

// ── Session ──────────────────────────────────────────────────────────────────

function SessionSection({ state, config }: { state: TuiState; config: AgentConfig }): React.JSX.Element {
  const perm = state.permission || config.permissionMode;
  const permColor = perm === "readonly" ? theme.warn : perm === "ask" ? theme.accent : theme.dim;
  const model = state.model || config.model || "—";
  const dir = config.workdir.split("/").filter(Boolean).pop() ?? config.workdir;
  return (
    <Section title="SESSION">
      <SectionLine label="model" value={fit(model, INNER - 9)} />
      <SectionLine label="perm" value={perm} color={permColor} />
      <SectionLine label="dir" value={fit(dir, INNER - 9)} />
    </Section>
  );
}

// ── Plan (live checklist — từng step, dữ liệu từ write_todos) ────────────────

type TodoItem = Extract<ChatItem, { kind: "todo" }>["items"][number];

function PlanRow({ t, width }: { t: TodoItem; width: number }): React.JSX.Element {
  if (t.status === "completed") {
    return (
      <Text wrap="truncate">
        <Text color={theme.success}>  ✔ </Text>
        <Text color={theme.success} dimColor>{fit(t.content, width - 4)}</Text>
      </Text>
    );
  }
  if (t.status === "in_progress") {
    return (
      <Text wrap="truncate">
        <Text color={theme.accent}>  ◆ </Text>
        <Text color={theme.accent} bold>{fit(t.content, width - 4)}</Text>
      </Text>
    );
  }
  return (
    <Text wrap="truncate" dimColor>
      {"  ○ "}{fit(t.content, width - 4)}
    </Text>
  );
}

function PlanSection({ state }: { state: TuiState }): React.JSX.Element {
  const plan = latestPlan(state.items);
  return (
    <Section title="PLAN">
      {!plan || plan.items.length === 0 ? (
        <Text dimColor>  no plan yet</Text>
      ) : (
        <Box flexDirection="column" flexShrink={0}>
          {(() => {
            const done = plan.items.filter((t) => t.status === "completed").length;
            return <Text>  <Text bold>{done}</Text><Text dimColor>/{plan.items.length} steps</Text></Text>;
          })()}
          {plan.items.slice(0, MAX_PLAN_ROWS).map((t, i) => (
            <PlanRow key={i} t={t} width={INNER} />
          ))}
          {plan.items.length > MAX_PLAN_ROWS && (
            <Text dimColor>  … +{plan.items.length - MAX_PLAN_ROWS} more</Text>
          )}
        </Box>
      )}
    </Section>
  );
}

// ── Metrics (tok/s · ctx · cost · elapsed · fuel gauge · guardrails) ─────────

function MetricsSection({ state }: { state: TuiState }): React.JSX.Element {
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const hasUsage = state.usage.calls > 0;
  const elapsedMs = state.startedAt ? (state.endedAt ?? Date.now()) - state.startedAt : null;
  const elapsedSec = elapsedMs != null ? Math.floor(elapsedMs / 1000) : null;
  const gauge = fuelGauge(state.step, state.maxSteps);
  const cost =
    (state.usage.inputTokens / 1_000_000) * resolveModelPricing(state.model).input +
    (state.usage.outputTokens / 1_000_000) * resolveModelPricing(state.model).output;
  // tok/s: output tokens / giây thô (chưa floor — 0.6s run đầu vẫn ra số).
  const tokPerSec =
    hasUsage && elapsedMs != null && elapsedMs > 500
      ? Math.round(state.usage.outputTokens / (elapsedMs / 1000))
      : null;
  // Live estimate based on accumulated streaming chars (chars / ~4 ≈ tokens).
  const liveTokPerSec =
    state.streamingOutputChars > 0 && elapsedMs != null && elapsedMs > 500
      ? Math.round((state.streamingOutputChars / 4) / (elapsedMs / 1000))
      : null;
  const win = contextWindowFor(state.provider, state.model);
  const ctxPct = hasUsage && win > 0 ? Math.round((state.usage.inputTokens / win) * 100) : null;
  // ctx giờ hiển thị đủ số: `input/ctxWin (pct%)`.
  const ctxFmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n));
  const ctxDisplay = ctxPct != null
    ? `${ctxFmt(state.usage.inputTokens)}/${ctxFmt(win)} (${ctxPct}%)`
    : null;
  return (
    <Section title="METRICS">
      {!hasUsage && elapsedSec == null ? (
        <Text dimColor>  starting…</Text>
      ) : (
        <Box flexDirection="column" flexShrink={0}>
          {gauge && (
            <Text wrap="truncate">
              <Text dimColor>  steps </Text>
              <Text color={gaugeColor(state.step, state.maxSteps)}>{gauge}</Text>
              <Text dimColor> {state.step}/{state.maxSteps}</Text>
            </Text>
          )}
          {hasUsage && (
            <SectionLine label="toks" value={`${fmt(state.usage.inputTokens)} → ${fmt(state.usage.outputTokens)}`} />
          )}
          {/* Show one speed line: live ~N during streaming, then N once usage events fire. */}
          {tokPerSec != null && (
            <SectionLine label="speed" value={`${fmt(tokPerSec)} tok/s`} color={theme.accent} />
          )}
          {liveTokPerSec != null && tokPerSec == null && (
            <SectionLine label="speed" value={`~${fmt(liveTokPerSec)} tok/s`} color={theme.accent} />
          )}
          {ctxDisplay != null && <SectionLine label="ctx" value={ctxDisplay} />}
          {cost > 0 && <SectionLine label="cost" value={`$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`} />}
          {elapsedSec != null && (
            <SectionLine label="elapsed" value={`${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`} />
          )}
          {state.usage.cachedTokens > 0 && (
            <SectionLine label="cached" value={fmt(state.usage.cachedTokens)} />
          )}
          {state.guardrailCount > 0 && (
            <SectionLine label="guard" value={String(state.guardrailCount)} color={theme.warn} />
          )}
        </Box>
      )}
    </Section>
  );
}

// ── Phases (plan › explore › edit › build › verify — vertical) ───────────────

const PHASES = ["plan", "explore", "edit", "build", "verify"] as const;

function PhaseSection({ state }: { state: TuiState }): React.JSX.Element {
  if (state.phases.length === 0) {
    return (
      <Section title="PHASES">
        <Text dimColor>  — idle</Text>
      </Section>
    );
  }
  const current = state.phases[state.phases.length - 1];
  return (
    <Section title="PHASES">
      <Box flexDirection="column" flexShrink={0}>
        {PHASES.map((p) => {
          const visited = state.phases.includes(p);
          const isCurrent = p === current;
          return (
            <Text key={p} wrap="truncate">
              <Text dimColor>  </Text>
              {isCurrent ? (
                <Text color={theme.accent} bold>◆ {p}</Text>
              ) : visited ? (
                <Text color={theme.success}>✔ {p}</Text>
              ) : (
                <Text dimColor>· {p}</Text>
              )}
            </Text>
          );
        })}
      </Box>
    </Section>
  );
}

// ── Build (lamp + command) ───────────────────────────────────────────────────

function BuildSection({ state, config }: { state: TuiState; config: AgentConfig }): React.JSX.Element {
  const lampLabel = state.buildLamp === "ok" ? "build ok" : state.buildLamp === "fail" ? "build fail" : "no build yet";
  const lampColor = state.buildLamp === "ok" ? theme.success : state.buildLamp === "fail" ? theme.error : theme.dim;
  const cmd = state.buildCmd || config.buildCmd || null;
  return (
    <Section title="BUILD">
      <Text wrap="truncate">
        <Text color={lampColor}>  ● {lampLabel}</Text>
      </Text>
      {cmd && <Text dimColor wrap="truncate">  {fit(cmd, INNER)}</Text>}
    </Section>
  );
}

// ── MCP (trạng thái từng server — từ event mcp_status structured) ────────────

function McpSection({ state, config }: { state: TuiState; config: AgentConfig }): React.JSX.Element {
  const names = Object.keys(config.mcpServers ?? {});
  return (
    <Section title="MCP">
      {names.length === 0 ? (
        <Text dimColor>  none configured</Text>
      ) : (
        <Box flexDirection="column" flexShrink={0}>
          {names.map((n) => {
            const st = state.mcpServers[n] ?? "waiting";
            const color = st === "ready" ? theme.success : st === "dead" ? theme.error : st === "waiting" ? theme.dim : theme.warn;
            const mark = st === "ready" ? "●" : st === "dead" ? "✘" : "◐";
            const budget = Math.max(6, INNER - 3 - st.length - 1);
            return (
              <Text key={n} wrap="truncate">
                <Text color={color}>  {mark} </Text>
                <Text color={color}>{fit(n, budget)}</Text>
                <Text dimColor> {st}</Text>
              </Text>
            );
          })}
        </Box>
      )}
    </Section>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

/** Sidebar phải — mọi trạng thái sống của run, cập nhật theo AgentEvent. */
export function Sidebar({ state, config }: { state: TuiState; config: AgentConfig }): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
      width={SIDEBAR_WIDTH}
      paddingX={1}
      flexShrink={0}
      overflow="hidden"
    >
      <SessionSection state={state} config={config} />
      <PlanSection state={state} />
      <MetricsSection state={state} />
      <PhaseSection state={state} />
      <BuildSection state={state} config={config} />
      <McpSection state={state} config={config} />
    </Box>
  );
}
