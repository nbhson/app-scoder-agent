/**
 * Sidebar bên phải (pattern opencode) — "mission control" panel: session,
 * plan live, metrics (tok/s · ctx · cost), phases, build lamp, MCP servers.
 *
 * Nền panel theo theme (theme.panelBg) tạo chiều sâu, tách khỏi chat
 * transcript để chat sạch và trạng thái luôn nhìn thấy mà không cần scroll.
 * Ẩn hoàn toàn trên terminal hẹp (< SIDEBAR_MIN_COLS) — khi đó BuildRail
 * fallback sang header đầy đủ (chrome.tsx).
 * (Guardrail notice trước đây nằm cuối sidebar — đã chuyển lên header, căn giữa.)
 *
 * Height budget (xem Sidebar root): nội dung thường cao hơn chiều cao khả dụng
 * trên terminal 24–30 dòng; greedy-fit theo đúng thứ tự hiển thị gốc
 * SESSION → MCP → METRICS → PHASES → PLAN → SUBAGENTS → BUILD, section không
 * vừa trọn vẹn thì bỏ qua (không clip nửa chừng); riêng PLAN co giãn theo chỗ
 * còn lại.
 */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { AgentConfig } from "../config/config.js";
import { contextWindowFor } from "../llm/model-catalog.js";
import { type ChatItem, type TuiState } from "./state.js";
import { ctxPctOf, runCostUsd } from "./metrics.js";
import {
  DEFAULT_LOG_VIEW,
  filterLog,
  fmtLogClock,
  logColor,
  logDetailLines,
  logKind,
  logKindColor,
  logSuffix,
  logWindow,
  type LogFilter,
  type LogView,
} from "./log.js";
import { clipCells } from "./text-width.js";
import { fit, theme } from "./theme.js";
import { charset } from "./charset.js";
import { fuelGauge, gaugeColor, SIDEBAR_WIDTH } from "./chrome.js";

const INNER = SIDEBAR_WIDTH - 4; // border + paddingX
const MAX_PLAN_ROWS = 14; // cap chiều cao — plan dài thì gộp "+N more"

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  // Header chuẩn design-system: rule mảnh + tiêu đề bold + rule lấp đầy chiều
  // ngang còn lại — phân tách section rõ ràng mà không cần khung nặng.
  const rule = charset.h.repeat(Math.max(0, INNER - title.length - 3));
  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Text wrap="truncate">
        <Text dimColor>{charset.h} </Text>
        <Text bold>{title}</Text>
        <Text dimColor> {rule}</Text>
      </Text>
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
  const model = state.model || config.model || "—";
  // P2.2: routing mode badge — [auto] khi RouterRuntime đang thật sự route.
  const routed = state.routerTiers.length > 0 ? (state.routingMode === "auto" ? " [auto]" : " [pin]") : "";
  const dir = config.workdir.split("/").filter(Boolean).pop() ?? config.workdir;
  return (
    <Section title="SESSION">
      <SectionLine label="model" value={fit(model + routed, INNER - 9)} />
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

function PlanSection({ state, cap }: { state: TuiState; cap: number }): React.JSX.Element {
  const plan = state.plan;
  return (
    <Section title="PLAN">
      {!plan || plan.length === 0 ? (
        <Text dimColor>  no plan yet</Text>
      ) : (
        <Box flexDirection="column" flexShrink={0}>
          {(() => {
            const done = plan.filter((t) => t.status === "completed").length;
            return <Text>  <Text bold>{done}</Text><Text dimColor>/{plan.length} steps</Text></Text>;
          })()}
          {plan.slice(0, cap).map((t, i) => (
            <PlanRow key={i} t={t} width={INNER} />
          ))}
          {plan.length > cap && (
            <Text dimColor>  … +{plan.length - cap} more</Text>
          )}
        </Box>
      )}
    </Section>
  );
}

// ── Metrics (tok/s · ctx · cost · elapsed · fuel gauge · guardrails) ─────────

/**
 * Danh sách dòng metrics — dùng chung cho render VÀ ước lượng chiều cao
 * (sidebar budget), nên 2 chỗ không bao giờ lệch nhau.
 */
function buildMetricsRows(state: TuiState): React.ReactNode[] {
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const hasUsage = state.usage.calls > 0;
  const elapsedMs = state.startedAt ? (state.endedAt ?? Date.now()) - state.startedAt : null;
  const elapsedSec = elapsedMs != null ? Math.floor(elapsedMs / 1000) : null;
  const gauge = fuelGauge(state.step, state.maxSteps);
  const cost = runCostUsd(state);
  // tok/s of the most recently completed LLM call (output tokens / call duration).
  // This is NOT averaged over the whole run (which includes tool/build time and
  // dilutes the number); it reflects the model's actual generation speed.
  const tokPerSec = state.lastLlmTokPerSec;
  // Live estimate during an active stream: chars so far / elapsed since the
  // first delta of this stream.
  const streamElapsedMs =
    state.streamStartedAt != null ? Date.now() - state.streamStartedAt : null;
  const liveTokPerSec =
    state.streamingOutputChars > 0 && streamElapsedMs != null && streamElapsedMs > 250
      ? Math.round((state.streamingOutputChars / 4) / (streamElapsedMs / 1000))
      : null;
  const win = contextWindowFor(state.provider, state.model);
  // `ctx` should reflect the CURRENT context window pressure (estimateTokens of
  // the live message history), NOT the cumulative input tokens spent across the
  // whole session (state.usage.inputTokens grows forever and can exceed 100%).
  // state.context is emitted by the agent after every LLM turn; fall back to the
  // cumulative counter only before the first turn has reported.
  const ctxTokens = state.context?.tokens ?? (hasUsage ? state.usage.inputTokens : null);
  const ctxWindow = state.context?.window ?? win;
  const ctxPct = ctxPctOf(state);
  // ctx giờ hiển thị đủ số: `current/ctxWin (pct%)`.
  const ctxFmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n));
  const ctxDisplay =
    ctxTokens != null && ctxPct != null
      ? `${ctxFmt(ctxTokens)}/${ctxFmt(ctxWindow)} (${ctxPct}%)`
      : null;
  if (!hasUsage && elapsedSec == null) return [];
  const rows: React.ReactNode[] = [];
  if (gauge) {
    rows.push(
      <Text key="gauge" wrap="truncate">
        <Text dimColor>  steps </Text>
        <Text color={gaugeColor(state.step, state.maxSteps)}>{gauge}</Text>
        <Text dimColor> {state.step}/{state.maxSteps}</Text>
      </Text>,
    );
  }
  if (hasUsage) {
    rows.push(<SectionLine key="toks" label="toks" value={`${fmt(state.usage.inputTokens)} → ${fmt(state.usage.outputTokens)}`} />);
  }
  if (!hasUsage && state.streamingOutputChars > 0) {
    rows.push(<SectionLine key="toks" label="toks" value={`~${fmt(Math.round(state.streamingOutputChars / 4))} (streaming)`} color={theme.accent} />);
  }
  // Show one speed line: live ~N during streaming, then N once usage events fire.
  if (tokPerSec != null) {
    rows.push(<SectionLine key="speed" label="speed" value={`${fmt(tokPerSec)} tok/s`} color={theme.accent} />);
  }
  if (liveTokPerSec != null && tokPerSec == null) {
    rows.push(<SectionLine key="speed" label="speed" value={`~${fmt(liveTokPerSec)} tok/s`} color={theme.accent} />);
  }
  if (ctxDisplay != null) rows.push(<SectionLine key="ctx" label="ctx" value={ctxDisplay} />);
  if (cost > 0) rows.push(<SectionLine key="cost" label="cost" value={`$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`} />);
  if (elapsedSec != null) {
    rows.push(<SectionLine key="elapsed" label="elapsed" value={`${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`} />);
  }
  if (state.usage.cachedTokens > 0) {
    rows.push(<SectionLine key="cached" label="cached" value={fmt(state.usage.cachedTokens)} />);
  }
  if (state.guardrailCount > 0) {
    rows.push(<SectionLine key="guard" label="guard" value={String(state.guardrailCount)} color={theme.warn} />);
  }
  return rows;
}

function MetricsSection({ rows }: { rows: React.ReactNode[] }): React.JSX.Element {
  return (
    <Section title="METRICS">
      {rows.length === 0 ? (
        <Text dimColor>  starting…</Text>
      ) : (
        <Box flexDirection="column" flexShrink={0}>{rows}</Box>
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

// ── Subagent tree (Phase 7 — spawned via `task` tool) ────────────────────────

type SubagentInfo = { id: string; name: string; description: string; status: "running" | "ok" | "failed"; steps?: number; summary?: string };

function SubagentSection({ state }: { state: TuiState }): React.JSX.Element {
  if (state.subagents.length === 0) return <></>;
  return (
    <Section title="SUBAGENTS">
      {state.subagents.map((s: SubagentInfo) => {
        const color =
          s.status === "running" ? theme.accent :
          s.status === "ok" ? theme.success :
          theme.error;
        const mark = s.status === "running" ? "◐" : s.status === "ok" ? "✔" : "✘";
        const summary = s.summary ? ` — ${s.summary.slice(0, 50)}${s.summary.length > 50 ? "…" : ""}` : "";
        const steps = s.steps != null ? ` (${s.steps} steps)` : "";
        return (
          <Text key={s.id} wrap="truncate" dimColor>
            <Text color={color}>  {mark} </Text>
            <Text color={color}>{s.name}</Text>
            <Text dimColor>{summary}{steps}</Text>
          </Text>
        );
      })}
    </Section>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

/** Chiều cao ước lượng (gồm title + marginBottom=1) của các section tĩnh. */
const SESSION_ROWS = 4; // title + model + dir
const PHASES_ROWS = 7; // title + 5 phase
const PHASES_IDLE_ROWS = 3; // title + "— idle"

/**
 * Sidebar phải — mọi trạng thái sống của run, cập nhật theo AgentEvent.
 *
 * Thứ tự section CỐ ĐỊNH (layout gốc): SESSION → MCP → METRICS → PHASES →
 * PLAN → SUBAGENTS → BUILD.
 *
 * Height-aware: nội dung sidebar thường CAO HƠN chiều cao khả dụng (terminal
 * 24–30 dòng trừ BuildRail/input/StatusBar). Greedy-fit theo đúng thứ tự
 * hiển thị với budget chiều cao thật (`rows` do app.tsx đo từ khung chính):
 * section nào không vừa trọn vẹn thì BỎ QUA (không clip nửa chừng). Riêng
 * PLAN co giãn được — cap số dòng theo chỗ còn lại + dòng "… +N more".
 *
 * `rows` = chiều cao ngoài của sidebar (= chiều cao chat viewport cùng hàng).
 * undefined/0 (chưa đo xong) → không giới hạn (behavior cũ, dùng trong tests).
 */
export type SidebarTab = "overview" | "router" | "log";

/** Next tab for the Ctrl+B cycle (P2.2 widened 2 → 3). */
export function nextSidebarTab(t: SidebarTab): SidebarTab {
  return t === "overview" ? "router" : t === "router" ? "log" : "overview";
}

export function Sidebar({ state, config, rows, tab = "overview", view = DEFAULT_LOG_VIEW }: { state: TuiState; config: AgentConfig; rows?: number; tab?: SidebarTab; view?: LogView }): React.JSX.Element {
  // Border top/bottom + the P8 tab-bar row + the 1-row gap under it all sit
  // inside the box: reserve 4.
  const avail = rows != null && rows > 0 ? Math.max(8, rows - 4) : Number.POSITIVE_INFINITY;
  // P2.2 Phase D: the route packet ticks only while a fresh decision is <~0.7s
  // old. Isolated frame state → only the sidebar re-renders per frame.
  const pulse = useRoutePulse(state.activeRoute?.ts ?? null);
  const flash = pulse >= 0 && state.activeRoute != null ? state.activeRoute.tier : null;

  let used = SESSION_ROWS;
  const fits = (h: number) => used + h <= avail;

  const body: React.ReactNode[] = [];

  // MCP — tĩnh theo config.
  const mcpH = 1 + Math.max(1, Object.keys(config.mcpServers ?? {}).length) + 1;
  if (fits(mcpH)) {
    used += mcpH;
    body.push(<McpSection key="mcp" state={state} config={config} />);
  }

  // METRICS — sống theo run.
  const metricsRows = buildMetricsRows(state);
  const metricsH = 1 + Math.max(1, metricsRows.length) + 1;
  if (fits(metricsH)) {
    used += metricsH;
    body.push(<MetricsSection key="metrics" rows={metricsRows} />);
  }

  // PHASES.
  const phasesH = state.phases.length === 0 ? PHASES_IDLE_ROWS : PHASES_ROWS;
  if (fits(phasesH)) {
    used += phasesH;
    body.push(<PhaseSection key="phases" state={state} />);
  }

  // PLAN — co giãn theo chỗ còn lại (plan rows từng dòng tự có nghĩa, khác
  // các section all-or-nothing). Overhead = title + dòng đếm + margin = 3;
  // khi bị cap chừa thêm 1 dòng "… +N more".
  const planItems = state.plan ?? [];
  if (planItems.length === 0) {
    if (fits(3)) {
      used += 3;
      body.push(<PlanSection key="plan" state={state} cap={MAX_PLAN_ROWS} />);
    }
  } else {
    let cap = Math.min(MAX_PLAN_ROWS, planItems.length, avail - used - 3);
    if (cap < planItems.length) cap -= 1; // chừa dòng "… +N more"
    if (cap >= 1) {
      used += 3 + cap + (cap < planItems.length ? 1 : 0);
      body.push(<PlanSection key="plan" state={state} cap={cap} />);
    }
  }

  // SUBAGENTS — chỉ khi có.
  if (state.subagents.length > 0) {
    const h = 1 + state.subagents.length + 1;
    if (fits(h)) {
      used += h;
      body.push(<SubagentSection key="subagents" state={state} />);
    }
  }

  // BUILD — lamp đã có trên BuildRail header, ưu tiên cuối.
  const buildH = 1 + 1 + (state.buildCmd || config.buildCmd ? 1 : 0) + 1;
  if (fits(buildH)) {
    body.push(<BuildSection key="build" state={state} config={config} />);
  }

  // ── P8/P2.2: tabbed sidebar ── OVERVIEW is the pre-tab panel; ROUTER draws
  // the routing graph; HARNESS LOG renders the reducer's ring buffer.
  if (tab === "router") {
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
        <TabBar active="router" count={state.log.length} dropped={state.logDropped} filter={view.filter} routerOn={state.routerTiers.length > 0} flash={flash} />
        <TabGap />
        <RouterTab state={state} rows={avail} pulse={pulse} />
      </Box>
    );
  }
  if (tab === "log") {
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
        <TabBar active="log" count={state.log.length} dropped={state.logDropped} filter={view.filter} routerOn={state.routerTiers.length > 0} flash={null} />
        <TabGap />
        <LogTab state={state} view={view} rows={avail} />
      </Box>
    );
  }

  // Tab-bar row + the 1-row gap below it are already reserved in `avail`
  // above — sections and their greedy-fit order are exactly as before, just
  // 1 row tighter.
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
      <TabBar active="overview" count={state.log.length} dropped={state.logDropped} filter={view.filter} routerOn={state.routerTiers.length > 0} flash={null} />
      <TabGap />
      <SessionSection state={state} config={config} />
      {body}
    </Box>
  );
}

// ── P8: tab bar ──────────────────────────────────────────────────────────────

/**
 * One blank row under the tab bar — the terminal's ~12px "margin-bottom" that
 * separates the OVERVIEW/HARNESS LOG tabs from the section content below.
 * Kept as a real row so the height budget (`avail`) accounts for it exactly.
 */
function TabGap(): React.JSX.Element {
  return <Box height={1} flexShrink={0} />;
}

const TAB_TXT: Record<SidebarTab, { hot: string; dim: string }> = {
  overview: { hot: "OVERVIEW", dim: "overview" },
  router: { hot: "ROUTER", dim: "router" },
  log: { hot: "HARNESS LOG", dim: "log" },
};

function TabBar({ active, count, dropped, filter, routerOn, flash }: {
  active: SidebarTab;
  count: number;
  dropped: number;
  filter: LogFilter;
  routerOn: boolean;
  flash: string | null;
}): React.JSX.Element {
  const on = (t: SidebarTab) => {
    const mark = t === "router" && routerOn ? " ⤳" : "";
    return active === t
      ? <Text bold backgroundColor={theme.accent} color="black">{` ${TAB_TXT[t].hot}${mark} `}</Text>
      : <Text dimColor>{` ${TAB_TXT[t].dim}${mark} `}</Text>;
  };
  return (
    <Text wrap="truncate">
      {on("overview")}
      <Text dimColor> │ </Text>
      {on("router")}
      {flash != null ? <Text color={theme.accent}>{` ⇢${flash}`}</Text> : null}
      <Text dimColor> │ </Text>
      {on("log")}
      <Text dimColor>{`  ${count}${dropped > 0 ? ` +${dropped}` : ""}`}{filter !== "ALL" ? ` · ${filter}` : ""}</Text>
    </Text>
  );
}

// ── P2.2: router tab ────────────────────────────────────────────────────────

const PULSE_FRAMES = 6;
const PULSE_MS = 110;
const GRAPH_MAX = 4; // sidebar cao hữu hạn — ref thứ 5+ gộp "+N more"
const DECISIONS_MAX = 4;
const STATS_MAX = 4;

/**
 * Phase D packet: một burst ~0.7 s mỗi khi có route_decision mới (dot chạy
 * trên cạnh router→model, không phải "particle" — terminal grid). Trả về frame
 * 0..PULSE_FRAMES-1, -1 = nghỉ. SCODER_ANIM=0 (CI/máy yếu) → luôn -1, graph
 * tĩnh hoàn toàn, không timer.
 */
function useRoutePulse(ts: number | null): number {
  const [frame, setFrame] = useState(-1);
  useEffect(() => {
    if (ts == null || process.env.SCODER_ANIM === "0") {
      setFrame(-1);
      return;
    }
    setFrame(0);
    let f = 0;
    const id = setInterval(() => {
      f += 1;
      if (f >= PULSE_FRAMES) setFrame(-1);
      else setFrame(f);
    }, PULSE_MS);
    return () => clearInterval(id);
  }, [ts]);
  return frame;
}

/** 3-char packet lane: dot "chạy" trên cạnh của ref đang active (charset-safe). */
function laneSegs(pulse: number): string {
  if (pulse < 0) return `${charset.h}${charset.h}${charset.arrowRight}`;
  const A = charset.active;
  const H = charset.h;
  return [`${A}${H}${H}`, `${H}${A}${H}`, `${H}${H}${A}`][pulse % 3];
}

const shortRef = (ref: string): string => ref.split("/").pop() ?? ref;

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/**
 * Một cạnh router→model. Dòng active mang packet lane (Phase D): dot ●
 * chạy 3 nhịp trên cạnh khi decision mới; idle = cạnh thường + marker ●
 * đứng (không màu nền, không reflow — grid terminal).
 */
function GraphEdge({ m, last, active, pulse }: {
  m: { ref: string; tier: "small" | "large" };
  last: boolean;
  active: boolean;
  pulse: number;
}): React.JSX.Element {
  const branch = last ? charset.bl : charset.teeRight;
  const lane = active && pulse >= 0 ? laneSegs(pulse) : `${charset.h}${charset.h}${charset.arrowRight}`;
  return (
    <Text wrap="truncate">
      <Text dimColor>{` ${branch}`}</Text>
      <Text color={active ? theme.accent : theme.dim}>{`${lane} `}</Text>
      <Text color={active ? theme.brand : theme.dim} bold={active}>{fit(shortRef(m.ref), INNER - 10)}</Text>
      {active ? <Text color={theme.accent}>{` ${charset.active}`}</Text> : null}
    </Text>
  );
}

function RouterTab({ state, rows, pulse }: { state: TuiState; rows: number; pulse: number }): React.JSX.Element {
  const tiers = state.routerTiers;
  const active = state.activeRoute;
  const decisions = filterLog(state.log, "ROUTE").slice(-DECISIONS_MAX).reverse();
  const stats = Object.entries(state.modelStats)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, STATS_MAX);

  const gShown = Math.min(tiers.length, GRAPH_MAX);
  const hGraph = tiers.length === 0 ? 2 : 2 + gShown + (tiers.length > gShown ? 1 : 0);
  const hDec = 1 + Math.max(1, decisions.length);
  const hStats = 1 + Math.max(1, stats.length);

  let used = hGraph;
  const body: React.ReactNode[] = [];

  body.push(
    <Section key="graph" title={`ROUTER · ${tiers.length === 0 ? "inactive" : state.routingMode}`}>
      {tiers.length === 0 ? (
        <Text dimColor>{`router off — rc "router": { enabled } + /model auto`}</Text>
      ) : (
        <>
          <Text dimColor>{`user ${charset.h}${charset.arrowRight} router`}</Text>
          {tiers.slice(0, gShown).map((t, i) => (
            <GraphEdge key={t.ref} m={t} last={i === gShown - 1} active={active?.ref === t.ref} pulse={active?.ref === t.ref ? pulse : -1} />
          ))}
          {tiers.length > gShown ? <Text dimColor>{`  └… +${tiers.length - gShown} refs (/router)`}</Text> : null}
        </>
      )}
    </Section>,
  );

  if (used + hDec <= rows) {
    used += hDec;
    body.push(
      <Section key="dec" title="DECISIONS">
        {decisions.length === 0 ? (
          <Text dimColor>no routes this run yet</Text>
        ) : (
          decisions.map((e) => (
            <Text key={e.id} wrap="truncate">
              <Text dimColor>{fmtLogClock(e.ts)}</Text>
              <Text color={logColor(e)}>{` ${clipCells(e.text, INNER - 12)}`}</Text>
              <Text dimColor>{logSuffix(e)}</Text>
            </Text>
          ))
        )}
      </Section>,
    );
  }

  if (used + hStats <= rows) {
    body.push(
      <Section key="stats" title="MODELS">
        {stats.length === 0 ? (
          <Text dimColor>no routed calls yet</Text>
        ) : (
          stats.map(([ref, s]) => (
            <Text key={ref} wrap="truncate">
              <Text color={s.tier === "large" ? theme.accent : theme.dim}>{fit(shortRef(ref), 11)}</Text>
              <Text dimColor>{` ${s.calls}c ${fmtK(s.input)}→${fmtK(s.output)}t ~$${s.costUsd < 0.01 ? s.costUsd.toFixed(4) : s.costUsd.toFixed(2)}`}</Text>
            </Text>
          ))
        )}
      </Section>,
    );
  }

  return <Box flexDirection="column">{body}</Box>;
}

// ── P8: harness log tab ───────────────────────────────────────────────────────

function LogTab({ state, view, rows }: { state: TuiState; view: LogView; rows: number }): React.JSX.Element {
  const filtered = filterLog(state.log, view.filter);
  const detailOn = view.detail && view.selId != null;
  const sel = detailOn ? state.log.find((e) => e.id === view.selId) : undefined;
  // DETAIL block = rule + lines + its own footer; the list also reserves the
  // "─ LOG ─" rule row and the bottom key-hint row, so the tab never overflows.
  const detailLines = sel ? logDetailLines(sel, INNER, clipCells) : [];
  const detailRows = sel ? detailLines.length + 2 : 0;
  const avail = Math.max(1, rows - 2 - detailRows);
  const win = logWindow(filtered, avail, view.offset);

  const lines: React.ReactNode[] = [];
  win.rows.forEach((e) => {
    const selected = e.id === view.selId;
    lines.push(
      <Text key={e.id} wrap="truncate">
        <Text dimColor>{selected ? "❱" : " "}</Text>
        <Text color={theme.dim}>{` ${fmtLogClock(e.ts)} `}</Text>
        <Text color={logKindColor(e)} bold={selected}>{`${logKind(e)} `}</Text>
        <Text bold={selected}>{clipCells(e.text + logSuffix(e), INNER - 17)}</Text>
      </Text>,
    );
  });

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text wrap="truncate">
        <Text dimColor>{`${charset.h} `}</Text>
        <Text bold>{`LOG${view.filter !== "ALL" ? ` · ${view.filter}` : ""}`}</Text>
        <Text dimColor>{` ${win.maxOffset > 0 ? `${Math.min(filtered.length, win.first + 1)}–${win.first + win.rows.length}/${filtered.length}` : `${filtered.length}`}`}</Text>
      </Text>
      {lines.length === 0 && <Text dimColor>  nothing yet — events land here as they happen</Text>}
      {lines}
      {sel && (
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor>{`${charset.h} DETAIL ${charset.h.repeat(Math.max(0, INNER - 8))}`}</Text>
          {detailLines.map((l, i) => (
            <Text key={i} dimColor wrap="truncate">  {l}</Text>
          ))}
          <Text dimColor>  Enter full · y copy · Esc close</Text>
        </Box>
      )}
      <Text dimColor>jk select · f filter · d detail · Enter/F</Text>
    </Box>
  );
}
