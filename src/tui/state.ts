/**
 * Pure event→state reducer for the Ink TUI (src/tui/app.tsx).
 *
 * Kept framework-free on purpose: the whole conversation model is derived from
 * AgentEvents (agent.onEvent), so it can be unit-tested without rendering and
 * mirrors how `scoder serve` consumes the same event stream.
 */
import type { AgentEvent } from "../agent.js";
import { resolveModelPricing } from "../shared/constants.js";
import { toolPhase } from "./selectors.js";


export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | {
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      /** T6: tool_call id — correlate tool_result (parallel same-name calls). */
      callId?: string;
      /** null = still running */
      ok: boolean | null;
      output: string;
      step: number;
      /** Wall-clock start of the tool call — pairs with durationMs. */
      startedAt?: number;
      /** Set when the tool finishes — shown next to the tool line. */
      durationMs?: number;
      /** T7: data URL ảnh (read_file trên file ảnh) — render halfblock/link. */
      image?: string;
    }
  | { kind: "notice"; text: string; level: "info" | "warn" | "error" }
  | { kind: "thinking"; text: string; streaming: boolean }
  | { kind: "build"; success: boolean; command: string }
  /** v2: compaction divider — "đã tóm tắt N tin nhắn · X→Y tokens". */
  | { kind: "compaction"; tokensBefore: number; tokensAfter: number; manual?: boolean }
  | { kind: "todo"; items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | {
      kind: "diff";
      path: string;
      text: string;
      added: number;
      removed: number;
      truncated: boolean;
      step: number;
    };

export type RunStatus = "idle" | "running" | "success" | "failed" | "aborted";

/** State of the last build event — drives the Build Rail lamp. */
export type BuildLamp = "none" | "ok" | "fail";

// ── Harness Log (P8) ─────────────────────────────────────────────────────────
// One ring-buffered line per meaningful harness activity, built INSIDE the
// reducer (single source of truth — CLI/serve don't change, UI just renders).
// Entries never carry big payloads: `ref` points back at state.items (or the
// session jsonl after MAX_ITEMS eviction), `meta` carries merge counters.

export type LogCat =
  | "run" | "llm" | "tool" | "shell" | "file" | "build" | "mcp"
  | "sub" | "guard" | "perm" | "evt" | "route";

export interface LogEntry {
  /** Monotonic id — selection anchors on this so the cursor survives growth. */
  id: number;
  /** Unix ms when the event reached the reducer. */
  ts: number;
  cat: LogCat;
  /** One-line summary; stored ≤200 chars, clipped to the pane at render. */
  text: string;
  /** Pointer to the full payload (resolved lazily by the viewer). */
  ref?: { kind: "item"; step: number; callId?: string; name?: string };
  meta?: {
    ms?: number;
    tokensIn?: number;
    tokensOut?: number;
    cached?: number;
    exit?: boolean | null;
    /** llm_delta/reasoning/tool_output merge counters (anti-spam). */
    chunks?: number;
    bytes?: number;
    /** tool_progress ticks. */
    count?: number;
    pct?: number;
    /** true = stream still open; later events MERGE into this row, never add. */
    live?: boolean;
    /**
     * Fold key for repeating events (context %, queue depth, todo flips,
     * warmup ticks, history trims): a new event with the same key REPLACES
     * this row's text and bumps `hits` instead of appending — so every event
     * is accounted for in the audit trail without flooding the ring.
     */
    key?: string;
    hits?: number;
  };
}

export interface TuiState {
  items: ChatItem[];
  status: RunStatus;
  step: number;
  maxSteps: number;
  model: string;
  provider: string;
  workdir: string;
  buildCmd: string;
  buildLamp: BuildLamp;
  permission: string;
  /** Unix ms when the current/last run started — drives the elapsed timer. */
  startedAt: number | null;
  /** Unix ms when the run finished — freezes the elapsed timer. */
  endedAt: number | null;
  usage: { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number };
  summary: string | null;
  /** Tổng số lần Guardrail Engine kích hoạt trong run. */
  guardrailCount: number;
  /** Guardrail gần nhất — "rule: reason" (ngắn) hiển thị trên header. */
  lastGuardrail: string | null;
  /** T-10: thinking stream visibility (ctrl+t toggle). */
  thinkingVisible: boolean;
  /** Các giai đoạn đã đi qua trong run (breadcrumb): plan/explore/edit/build/verify. */
  phases: string[];
  /** Sidebar: trạng thái kết nối từng MCP server (từ event mcp_status structured). */
  mcpServers: Record<string, string>;
  /** Live: accumulated streaming output chars during current run (chars / ~4 ≈ tokens). */
  streamingOutputChars: number;
  /** Timestamp (ms) when the current LLM stream started emitting deltas. */
  streamStartedAt: number | null;
  /** Timestamp (ms) when the current LLM call started (step boundary). */
  llmCallStartedAt: number | null;
  /** Tok/s of the most recently completed LLM call (output tokens / call duration). */
  lastLlmTokPerSec: number | null;
  /** v2: active primary agent name (from run_start). */
  agent: string;
  /** v2: context-window pressure from the last `context` event. */
  context: { tokens: number; window: number; pct: number } | null;
  /** v2: pending steering/queue depth (HUD badge). */
  queue: { pending: number; steering: number };
  /** v2: last reported verification verdict (from finish). */
  verification: { ok: boolean | null; detail: string } | null;
  /** v2: subagents spawned in this run (tree state for the sidebar). */
  subagents: Array<{ id: string; name: string; description: string; status: "running" | "ok" | "failed"; steps?: number; summary?: string }>;
  /** Background warm-up (prefix prefill) progress — null when inactive. */
  warmup: { active: boolean; stage: string; percent: number; message: string | null } | null;  /**
   * Plan hiện tại cho sidebar PLAN (nguồn: write_todos). Field riêng thay vì
   * derive từ items: todo chat-items bị MAX_ITEMS eviction xoá khỏi items trên
   * run dài, khiến plan "biến mất" khỏi sidebar. Reset khi user gửi message mới
   * (run_start, hoặc trực tiếp ở submit/steer path) — cùng ngữ nghĩa latestPlan.
   */
  plan: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | null;
  /** P8: harness log ring buffer (newest last). Immutable-append like items. */
  log: LogEntry[];
  /** Monotonic id source for LogEntry (never reused across resets). */
  logSeq: number;
  /** Entries evicted from the ring — the header shows `+N`. */
  logDropped: number;
  /**
   * P2.2 ROUTER tab: the newest routing decision (null = router has not
   * routed this run). Drives the graph highlight + RoutePacket target.
   */
  activeRoute: { ref: string; tier: "small" | "large"; step: number; ts: number } | null;
  /** P2.2: per-routed-ref accumulated usage, from llm_usage attribution. */
  modelStats: Record<string, ModelStat>;
  /** P2.2 §7: candidate graph from run_start.tiers (empty = no RouterRuntime). */
  routerTiers: Array<{ ref: string; tier: "small" | "large" }>;
  /** P2.2: "auto" when the run started with routing live, else pinned. */
  routingMode: "auto" | "pinned";
}

/** One routed model's running totals (sidebar ROUTER tab). */
export interface ModelStat {
  tier: "small" | "large" | null;
  calls: number;
  input: number;
  output: number;
  cached: number;
  /** estimated USD, table pricing without rc overrides (display only). */
  costUsd: number;
}

export function initialState(): TuiState {
  return {
    items: [],
    status: "idle",
    step: 0,
    maxSteps: 0,
    model: "",
    provider: "",
    workdir: "",
    buildCmd: "",
    buildLamp: "none",
    permission: "",
    startedAt: null,
    endedAt: null,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    summary: null,
    guardrailCount: 0,
    lastGuardrail: null,
    thinkingVisible: false,
    phases: [],
    mcpServers: {},
    streamingOutputChars: 0,
    streamStartedAt: null,
    llmCallStartedAt: null,
    lastLlmTokPerSec: null,
    agent: "build",
    context: null,
    queue: { pending: 0, steering: 0 },
    verification: null,
    subagents: [],
    plan: null,
    warmup: null,
    log: [],
    logSeq: 0,
    logDropped: 0,
    activeRoute: null,
    modelStats: {},
    routerTiers: [],
    routingMode: "pinned",
  };
}

const MAX_ITEMS = 400;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_TEXT_CHARS = 40_000;
export const MAX_LOG_ENTRIES = 800;
const LOG_TEXT_CAP = 200;

function appendItem(state: TuiState, item: ChatItem): void {
  state.items.push(item);
  if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS);
}

function lastItem(state: TuiState): ChatItem | undefined {
  return state.items[state.items.length - 1];
}

/**
 * Thay một chat item bằng bản copy đã patch — KHÔNG mutate in-place.
 * ChatItemView là React.memo: mutate in-place khiến prevProps.item ===
 * nextProps.item (cùng object), comparator so object với chính nó luôn
 * "bằng" → memo đóng băng UI (stream đứng ở chunk đầu, tool kẹt "running").
 */
function patchItem(state: TuiState, index: number, patch: Record<string, unknown>): void {
  state.items[index] = { ...state.items[index], ...patch } as ChatItem;
}

/** Cap long strings, keeping the tail (errors usually live at the end). */
function capTail(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `…[truncated ${text.length - max} chars]\n${text.slice(text.length - max)}`;
}

// ── Harness Log plumbing (P8) ────────────────────────────────────────────────

/** Append a log entry (immutable, ring-buffered — never mutate in place). */
function pushLog(
  state: TuiState,
  cat: LogCat,
  text: string,
  opts?: { ref?: LogEntry["ref"]; meta?: LogEntry["meta"] },
): LogEntry {
  const clipped = clipLog(text);  const entry: LogEntry = { id: state.logSeq, ts: Date.now(), cat, text: clipped, ...opts };
  state.logSeq += 1;
  state.log = [...state.log, entry];
  if (state.log.length > MAX_LOG_ENTRIES) {
    const cut = state.log.length - MAX_LOG_ENTRIES;
    state.log = state.log.slice(cut);
    state.logDropped += cut;
  }
  return entry;
}

/** UI-side note (permission answers, abort) — same ring, exported for hooks. */
export function logNote(state: TuiState, cat: LogCat, text: string): TuiState {
  pushLog(state, cat, text);
  return state;
}

/** Find the newest still-live entry of one of `cats` (optionally matching id/name). */
function findLive(state: TuiState, cats: LogCat[], match?: { callId?: string; name?: string }): number {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const e = state.log[i];
    if (!e.meta?.live || !cats.includes(e.cat)) continue;
    if (match?.callId != null && e.ref?.callId != null && e.ref.callId !== match.callId) continue;
    if (match?.name != null && e.ref?.name != null && e.ref.name !== match.name) continue;
    return i;
  }
  return -1;
}

/** Ring-buffer text cap — same rule whether appending or patching a row. */
function clipLog(text: string): string {
  return text.length > LOG_TEXT_CAP ? `${text.slice(0, LOG_TEXT_CAP - 1)}…` : text;
}

/** Merge patch into the entry at `i` — new object + new array, never in place. */
function patchLog(state: TuiState, i: number, patch: Partial<LogEntry> & { meta?: LogEntry["meta"] }): void {
  const prev = state.log[i];
  if (!prev) return;
  const next: LogEntry = { ...prev, ...patch, meta: { ...prev.meta, ...patch.meta } };
  if (next.text.length > LOG_TEXT_CAP) next.text = clipLog(next.text);
  state.log = [...state.log.slice(0, i), next, ...state.log.slice(i + 1)];
}

/** Compact token count: 18.2k / 940. */
function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Fold a REPEATING event into the newest row with the same `key` (refreshing
 * its text + timestamp and counting the hit), or open such a row. This is how
 * the audit log stays COMPLETE without flooding: every `context` / `queue` /
 * `todo` / `warmup` / `trim` event is represented, but N of them read as one
 * live line with a `×N` counter instead of N rows.
 */
function foldLog(state: TuiState, cat: LogCat, key: string, text: string, meta: LogEntry["meta"] = {}): void {
  // Only fold into a RECENT row (search is bounded): matching an old one would
  // drag its timestamp forward and break the chronological tail.
  for (let i = state.log.length - 1; i >= Math.max(0, state.log.length - 16); i--) {
    const e = state.log[i];
    if (e.cat === cat && e.meta?.key === key) {
      patchLog(state, i, { text: clipLog(text), ts: Date.now(), meta: { ...meta, key, hits: (e.meta?.hits ?? 1) + 1 } });
      return;
    }
  }
  pushLog(state, cat, text, { meta: { ...meta, key, hits: 1 } });
}

/** Short one-arg hint for a tool line (command/path first, like the transcript). */
function toolArgHint(args: Record<string, unknown>): string {
  for (const key of ["command", "path", "pattern", "query", "url", "id"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v.split("\n")[0];
  }
  return "";
}

/**
 * Anti-spam (P8): llm_delta / llm_reasoning NEVER create a row — they merge
 * chunks/bytes counters into the single open `llm` entry (rendered with a `…`
 * suffix while live). The row is created on the first delta of a call.
 */
function mergeLlmActivity(state: TuiState, bytes: number): void {
  const i = findLive(state, ["llm"]);
  if (i >= 0) {
    const m = state.log[i].meta;
    patchLog(state, i, { meta: { ...m, live: true, chunks: (m?.chunks ?? 0) + 1, bytes: (m?.bytes ?? 0) + bytes } });
    return;
  }
  // Text omits the "llm" word — the row's kind column (LLM) says it already.
  pushLog(state, "llm", `#${state.usage.calls + 1} streaming`, {
    ref: { kind: "item", step: state.step },
    meta: { live: true, chunks: 1, bytes, key: `llm#${state.usage.calls + 1}` },
  });
}

/** Guardrail event: đếm + giữ decision gần nhất (ngắn, tự giải thích cho header). */
function applyGuardrail(state: TuiState, ev: { rule: string; action: string; reason: string }): void {
  // history-trim là routine context management — không tính vào header, nhưng
  // audit log vẫn phải thấy nó (fold thành một dòng `trim ×N`).
  if (ev.action === "trim") {
    foldLog(state, "evt", "trim", `trim · ${ev.rule} — history trimmed`, {});
    return;
  }
  state.guardrailCount += 1;  // Thông điệp thân thiện theo rule — không dump raw "rule · reason" lên UI.
  const HUMAN: Record<string, string> = {
    "wrap-up": "sắp hết bước — yêu cầu agent chốt việc và chạy build",
    "chat-done": "lượt chat thuần — kết thúc không cần build",
    "completion-claim": "agent báo hoàn thành — buộc chạy build xác minh",
    "text-only-streak": "agent chỉ nói không làm — dừng run",
    "continue-nudge": "trả lời text chưa dùng tool — nhắc tiếp tục",
    "doom-loop": "lặp lẫn lộn cùng tool call — yêu cầu đổi hướng",
    "build-stop": "build pass — kết thúc run",
  };
  state.lastGuardrail = HUMAN[ev.rule] ?? `${ev.rule}: ${ev.reason}`;
  pushLog(state, "guard", `${ev.rule} → ${ev.action}`);
}

// Pure selectors live in ./selectors.js (Phase 5.4) — re-exported so existing
// import sites (app.tsx, hooks, tests) keep working unchanged.
export { estimateItemRows, visibleWindow, transcriptWindow, estimateTotalRows, latestPlan, toolPhase } from "./selectors.js";

/**
 * Fold one AgentEvent into the state (mutates `state`, returns it for
 * reducer-style chaining). Unknown events are ignored.
 */
export function applyEvent(state: TuiState, ev: AgentEvent): TuiState {
  switch (ev.type) {
    case "permission_request": {
      // T-03: surfaced via a dedicated React state hook in TuiApp (not the
      // chat items — the modal is modal, not transcript).
      pushLog(state, "perm", `ask ▸ ${ev.kind}: ${ev.command ?? ev.label}`, {
        ref: { kind: "item", step: state.step },
      });
      break;
    }
    case "run_start": {
      state.model = ev.model;
      state.provider = ev.provider;
      state.workdir = ev.workdir;
      state.buildCmd = ev.buildCmd;
      state.buildLamp = "none";
      state.permission = ev.permission;
      state.agent = ev.agent ?? "build";
      state.context = null;
      state.queue = { pending: 0, steering: 0 };
      state.verification = null;
      state.subagents = [];
      state.startedAt = Date.now();
      state.endedAt = null;
      state.status = "running";
      state.step = 0;
      state.summary = null;
      state.usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      // Reset tracking của run mới.
      state.guardrailCount = 0;
      state.lastGuardrail = null;
      state.phases = [];
      state.streamingOutputChars = 0;
      state.streamStartedAt = null;
      state.llmCallStartedAt = null;
      state.lastLlmTokPerSec = null;
      // P2.2: routing state is per-run too — the ROUTER tab starts empty.
      state.activeRoute = null;
      state.modelStats = {};
      state.routerTiers = ev.tiers ?? [];
      state.routingMode = ev.routingMode === "auto" ? "auto" : "pinned";
      // The TUI pushes the user's message itself when submitting; avoid a
      // duplicate when run_start carries the same task. `quiet` (resume) =
      // transcript đã hiển thị rồi, không append nữa. Scan back PAST notices:
      // a notice can land between the submit push and run_start (e.g. Enter
      // on the empty log tab → "no log row selected") — checking only the
      // last item used to miss the dedupe and print the command twice.
      let prev = state.items.length - 1;
      while (prev >= 0 && state.items[prev].kind === "notice") prev--;
      const before = prev >= 0 ? state.items[prev] : undefined;
      if (!ev.quiet && !(before && before.kind === "user" && before.text === ev.task)) {
        appendItem(state, { kind: "user", text: ev.task });
      }
      // Plan của task trước không được lọt sang task mới.
      state.plan = null;
      state.warmup = null;
      // Kind column already says RUN — keep the payload prefix `▸ build:` short.
      pushLog(state, "run", `▸ ${ev.agent ?? "build"}: ${ev.task}`);
      break;
    }
    case "llm_reasoning": {
      // P8: merge into the open llm row (never its own entry) even when the
      // transcript hides thinking — the harness log shows all activity.
      mergeLlmActivity(state, ev.delta.length);
      // T-10: thinking stream — chỉ append khi thinkingVisible; vẫn giữ trong
      // reasoning buffer riêng để toggle bật lại thấy (đơn giản: drop khi off).
      if (!state.thinkingVisible) break;
      const last = lastItem(state);
      if (last && last.kind === "thinking" && last.streaming) {
        let text = last.text + ev.delta;
        if (text.length > MAX_TEXT_CHARS) text = text.slice(-MAX_TEXT_CHARS);
        patchItem(state, state.items.length - 1, { text });
      } else {
        appendItem(state, { kind: "thinking", text: ev.delta, streaming: true });
      }
      break;
    }
    case "step": {
      state.step = ev.step;
      state.maxSteps = ev.maxSteps;
      // New LLM turn: reset per-stream tracking.
      state.streamingOutputChars = 0;
      state.streamStartedAt = null;
      state.llmCallStartedAt = Date.now();
      pushLog(state, "run", `step ${ev.step}/${ev.maxSteps === 0 ? "∞" : ev.maxSteps}`);
      // A new step starts: close any still-"streaming" assistant message.
      const last = lastItem(state);
      if (last && (last.kind === "assistant" || last.kind === "thinking") && last.streaming) {
        patchItem(state, state.items.length - 1, { streaming: false });
      }
      break;
    }
    case "llm_delta": {
      if (state.streamStartedAt == null) {
        state.streamStartedAt = state.llmCallStartedAt ?? Date.now();
      }
      state.streamingOutputChars += ev.delta.length;
      mergeLlmActivity(state, ev.delta.length);
      const last = lastItem(state);
      if (last && last.kind === "assistant" && last.streaming) {
        let text = last.text + ev.delta;
        if (text.length > MAX_TEXT_CHARS) text = text.slice(-MAX_TEXT_CHARS);
        patchItem(state, state.items.length - 1, { text });
      } else {
        if (last && last.kind === "assistant" && last.streaming === false && last.text === "") {
          // reuse an empty assistant placeholder from a previous step
          patchItem(state, state.items.length - 1, { streaming: true });
        } else {
          appendItem(state, { kind: "assistant", text: ev.delta, streaming: true });
        }
      }
      break;
    }
    case "llm_usage": {
      state.usage.calls += 1;
      state.usage.inputTokens += ev.usage.input_tokens ?? 0;
      state.usage.outputTokens += ev.usage.output_tokens ?? 0;
      state.usage.cachedTokens += ev.usage.cached_tokens ?? 0;
      // Per-call speed from the actual call duration, not the whole run.
      const start = state.streamStartedAt ?? state.llmCallStartedAt;
      let callMs: number | null = null;
      if (start != null) {
        callMs = Math.max(1, Date.now() - start);
        const out = ev.usage.output_tokens ?? 0;
        if (out > 0) {
          state.lastLlmTokPerSec = Math.round(out / (callMs / 1000));
        }
      }
      // P8: close the open llm row with the real numbers (call #, tokens,
      // cache hit, duration, merged chunk count). No open row → append one.
      {
        const inT = ev.usage.input_tokens ?? 0;
        const outT = ev.usage.output_tokens ?? 0;
        const cac = ev.usage.cached_tokens ?? 0;
        const li = findLive(state, ["llm"]);
        const chunks = li >= 0 ? state.log[li].meta?.chunks ?? 0 : 0;
        const bits = [
          `#${state.usage.calls} ${state.model || "?"}`,
          `in ${fmtK(inT)} out ${fmtK(outT)}${cac > 0 ? ` (cache ${fmtK(cac)})` : ""}`,
        ];
        if (callMs != null) bits.push(`${(callMs / 1000).toFixed(1)}s`);
        if (chunks > 0) bits.push(`${chunks} chunks`);
        const text = bits.join(" · ");
        const meta = { live: false, tokensIn: inT, tokensOut: outT, cached: cac, ms: callMs ?? undefined, chunks, key: `llm#${state.usage.calls}` };
        // Spread the open row's meta so its `key` survives the close — this
        // lets a late/orphaned usage event fold back into the same line.
        if (li >= 0) patchLog(state, li, { text, meta: { ...state.log[li].meta, ...meta } });
        else pushLog(state, "llm", text, { ref: { kind: "item", step: state.step }, meta });
      }
      // P2.2: per-ref accumulation when the call was routed (ROUTER tab stats).
      if (ev.ref) {
        const prev = state.modelStats[ev.ref] ?? { tier: ev.tier ?? null, calls: 0, input: 0, output: 0, cached: 0, costUsd: 0 };
        const price = resolveModelPricing(ev.ref.split("/").pop() ?? ev.ref);
        const inT = ev.usage.input_tokens ?? 0;
        const outT = ev.usage.output_tokens ?? 0;
        state.modelStats = {
          ...state.modelStats,
          [ev.ref]: {
            ...prev,
            tier: ev.tier ?? prev.tier,
            calls: prev.calls + 1,
            input: prev.input + inT,
            output: prev.output + outT,
            cached: prev.cached + (ev.usage.cached_tokens ?? 0),
            costUsd: prev.costUsd + (inT / 1_000_000) * price.input + (outT / 1_000_000) * price.output,
          },
        };
      }
      state.streamingOutputChars = 0;
      state.streamStartedAt = null;
      break;
    }
    case "route_decision": {
      // P2.2 ROUTER tab: newest decision + honest model name for the usage
      // lines that follow, and one folded audit row per tier×ref×reason so
      // repeated routes read as `×N` instead of flooding the ring (§7).
      state.activeRoute = { ref: ev.ref, tier: ev.tier, step: ev.step, ts: Date.now() };
      state.model = ev.model;
      state.provider = ev.provider;
      const head = ev.reason.split(" · ")[0];
      const j = ev.judge ? ` ⤳j:${ev.judge.verdict}` : "";
      foldLog(state, "route", `${ev.tier}|${ev.ref}|${head}`, `⤳ ${ev.tier} ${ev.ref.split("/").pop() ?? ev.ref} — ${head}${j}`);
      break;
    }
    case "tool_call": {
      appendItem(state, {
        kind: "tool",
        name: ev.name,
        args: ev.args,
        callId: ev.id,
        ok: null,
        output: "",
        step: ev.step,
        startedAt: Date.now(),
      });
      // Phase tracking cho breadcrumb (không trùng phase liền trước).
      const phase = toolPhase(ev.name);
      if (phase && state.phases[state.phases.length - 1] !== phase) state.phases.push(phase);
      // P8: shell commands get their own category (⚡); the row stays open
      // (live) until tool_result — tool_output only merges byte counters.
      {
        const isShell = ev.name === "run_command";
        const arg = isShell ? String(ev.args.command ?? "") : toolArgHint(ev.args);
        pushLog(state, isShell ? "shell" : "tool", isShell ? arg : `${ev.name} ${arg}`.trim(), {
          ref: { kind: "item", step: ev.step, callId: ev.id, name: ev.name },
          // key = tool name: findLive merges output/progress by name anyway,
          // and the key lets a late result fold into the row after it closed.
          meta: { live: true, key: ev.name },
        });
      }
      break;
    }
    case "tool_output": {
      // Live stdout/stderr chunks attach to the most recent running tool item.
      for (let i = state.items.length - 1; i >= 0; i--) {
        const it = state.items[i];
        if (it.kind === "tool" && it.ok === null && it.name === ev.name) {
          let output = it.output + ev.delta;
          if (output.length > MAX_OUTPUT_CHARS) output = capTail(output);
          patchItem(state, i, { output });
          break;
        }
        // Stop searching at the previous tool boundary to avoid cross-attachment.
        if (it.kind === "tool") break;
      }
      // P8 anti-spam: stdout/stderr NEVER append a log row — bytes merge into
      // the open tool/shell row for the same tool name.
      {
        const li = findLive(state, ["tool", "shell"], { name: ev.name });
        if (li >= 0) {
          const m = state.log[li].meta;
          patchLog(state, li, { meta: { ...m, live: true, bytes: (m?.bytes ?? 0) + ev.delta.length } });
        }
      }
      break;
    }
    case "tool_result": {
      // T6: correlate theo callId (parallel calls cùng tên vẫn đúng card);
      // fallback theo name cho event cũ không id.
      for (let i = state.items.length - 1; i >= 0; i--) {
        const it = state.items[i];
        const match = it.kind === "tool" && it.ok === null && (ev.id ? it.callId === ev.id : it.name === ev.name);
        if (match) {
          patchItem(state, i, {
            ok: ev.ok,
            durationMs: it.startedAt != null ? Date.now() - it.startedAt : it.durationMs,
            // Prefer the final (complete) result over accumulated live chunks.
            output: ev.output.length >= it.output.length ? ev.output : it.output,
            image: ev.image ?? it.image,
          });
          break;
        }
      }
      // File-writing tools attach a unified diff — render it as its own item
      // so edits are reviewable at a glance (the scoder "✎" signature).
      if (ev.diff) {
        appendItem(state, {
          kind: "diff",
          path: ev.diff.path,
          text: ev.diff.text,
          added: ev.diff.added,
          removed: ev.diff.removed,
          truncated: ev.diff.truncated,
          step: ev.step,
        });
        // P8: file edits get their own ✎ row (the tool row stays as-is).
        pushLog(state, "file", `+${ev.diff.added} -${ev.diff.removed} ${ev.diff.path}`, {
          ref: { kind: "item", step: ev.step, callId: ev.id, name: ev.name },
        });
      }
      // P8: close the open tool/shell row with the verdict + duration.
      {
        const li = findLive(state, ["tool", "shell"], { callId: ev.id, name: ev.name });
        const verdict = ` → ${ev.ok ? "ok" : "FAILED"}`;
        if (li >= 0) {
          const e = state.log[li];
          const ms = e.ts != null ? Date.now() - e.ts : undefined;
          patchLog(state, li, {
            text: `${e.text}${verdict}${ms != null ? ` · ${(ms / 1000).toFixed(1)}s` : ""}`,
            meta: { live: false, exit: ev.ok, ms },
          });
        } else {
          pushLog(state, ev.name === "run_command" ? "shell" : "tool", `${ev.name}${verdict}`, {
            ref: { kind: "item", step: ev.step, callId: ev.id, name: ev.name },
            meta: { live: false, exit: ev.ok },
          });
        }
      }
      break;
    }
    case "build": {
      state.buildLamp = ev.success ? "ok" : "fail";
      if (state.phases[state.phases.length - 1] !== "verify") state.phases.push("verify");
      appendItem(state, { kind: "build", success: ev.success, command: ev.command });
      pushLog(state, "build", `${ev.command} → ${ev.success ? "PASS" : "FAIL"}`);
      break;
    }
    case "todo": {
      // Snapshot last-wins cho sidebar PLAN (field riêng, không bị MAX_ITEMS
      // eviction xoá trên run dài). Chat item vẫn append để giữ transcript.
      state.plan = ev.items.map((t) => ({ ...t }));
      appendItem(state, { kind: "todo", items: ev.items.map((t) => ({ ...t })) });
      // Every todo event is accounted for, but N updates of the SAME checklist
      // fold into one line (`×N`) — status flips would otherwise flood the ring.
      const done = ev.items.filter((t) => t.status === "completed").length;
      foldLog(
        state,
        "evt",
        `plan#${ev.items.length}`,
        `plan · ${ev.items.length} todos (${done} done)`,
      );
      break;
    }
    case "guardrail": {
      applyGuardrail(state, ev);
      break;
    }
    case "mcp_status": {
      // Sidebar: structured event (server+state) → cập nhật map, không spam chat.
      // onStatus riêng vẫn đẩy notice text đầy đủ cho transcript.
      if (ev.server && ev.state) {
        state.mcpServers = { ...state.mcpServers, [ev.server]: ev.state };
        pushLog(state, "mcp", `${ev.server} ${ev.state}`);
        break;
      }
      if (state.warmup?.active) break;
      appendItem(state, { kind: "notice", text: ev.line, level: ev.line.includes("unavailable") ? "warn" : "info" });
      pushLog(state, "mcp", ev.line);
      break;
    }
    case "steer_queued": {
      // Pending depth tracked via the absolute `queue` event; nothing else.
      state.queue = { ...state.queue, pending: state.queue.pending + 1, steering: state.queue.steering + (ev.mode === "steer" ? 1 : 0) };
      pushLog(state, "evt", `${ev.mode} +1 · queue ${state.queue.pending}`);
      break;
    }
    case "steer_delivered": {
      state.queue = { pending: 0, steering: 0 };
      appendItem(state, { kind: "notice", text: `steer: ${ev.count} message(s) delivered`, level: "info" });
      pushLog(state, "evt", `steer delivered ×${ev.count}`);
      break;
    }
    case "queue": {
      state.queue = { pending: ev.pending, steering: ev.steering };
      // Depth is re-reported constantly; fold it into one live line (`×N`).
      foldLog(state, "evt", "queue", `queue ${ev.pending} pending · ${ev.steering} steering`);
      break;
    }
    case "compaction": {
      appendItem(state, { kind: "compaction", tokensBefore: ev.tokensBefore, tokensAfter: ev.tokensAfter, manual: ev.manual });
      pushLog(state, "evt", `compact ${fmtK(ev.tokensBefore)}→${fmtK(ev.tokensAfter)}${ev.manual ? " (manual)" : ""}`);
      break;
    }
    case "context": {
      state.context = { tokens: ev.tokens, window: ev.window, pct: ev.pct };
      // One report per step → fold into a single live pressure line showing the
      // LATEST value + how many reports it absorbed. Nothing is dropped, so the
      // audit trail is complete without 40 near-identical rows per run.
      foldLog(
        state,
        "evt",
        "ctx",
        `ctx ${ev.pct}% (${fmtK(ev.tokens)}/${fmtK(ev.window)})${ev.compacted ? " · compacted" : ""}`,
        { pct: ev.pct },
      );
      break;
    }
    case "agent_start": {
      // Track in the tree list; rendering lands in the sidebar (Phase 7).
      const rest = state.subagents.filter((s) => s.id !== ev.id);
      rest.push({ id: ev.id, name: ev.name, description: ev.description, status: "running" });
      state.subagents = rest.slice(-20);
      pushLog(state, "sub", `▸ ${ev.name}: ${ev.description}`, {
        ref: { kind: "item", step: state.step, callId: ev.id },
        meta: { live: true },
      });
      break;
    }
    case "agent_end": {
      state.subagents = state.subagents.map((s) =>
        s.id === ev.id ? { ...s, status: ev.ok ? "ok" : "failed", steps: ev.steps, summary: ev.summary } : s,
      );
      {
        const li = findLive(state, ["sub"], { callId: ev.id });
        const name = state.subagents.find((s) => s.id === ev.id)?.name ?? "subagent";
        const text = `${name} ${ev.ok ? "done" : "FAILED"} · ${ev.steps} steps`;
        if (li >= 0) patchLog(state, li, { text, meta: { live: false, count: ev.steps } });
        else pushLog(state, "sub", text, { ref: { kind: "item", step: state.step, callId: ev.id }, meta: { count: ev.steps } });
      }
      break;
    }
    case "tool_progress": {
      // Attach latest progress message to the running tool card (if any).
      for (let i = state.items.length - 1; i >= 0; i--) {
        const it = state.items[i];
        if (it.kind === "tool" && it.ok === null && (it.callId === ev.id || it.name === ev.name)) {
          if (ev.message) patchItem(state, i, { output: capTail(`${it.output}\n… ${ev.message}`.trim()) });
          break;
        }
        if (it.kind === "tool") break;
      }
      // P8: progress ticks merge into the open row (count), never a new line.
      {
        const li = findLive(state, ["tool", "shell"], { callId: ev.id, name: ev.name });
        if (li >= 0) {
          const m = state.log[li].meta;
          patchLog(state, li, { meta: { ...m, live: true, count: (m?.count ?? 0) + 1 } });
        }
      }
      break;
    }
    case "question_request": {
      // Surfaced via the dedicated ask_user modal (Phase 3/7); queue a notice
      // so the transcript isn't silent while waiting for user input.
      appendItem(state, { kind: "notice", text: `❓ ${ev.question}`, level: "info" });
      pushLog(state, "perm", `ask ▸ ${ev.question}`, { ref: { kind: "item", step: state.step } });
      break;
    }
    case "finish": {
      state.status = ev.success ? "success" : /interrupted|aborted/i.test(ev.summary) ? "aborted" : "failed";
      state.summary = ev.summary;
      state.endedAt = Date.now();
      if (ev.usage) state.usage = { ...ev.usage };
      if (ev.verification) state.verification = { ...ev.verification };
      // Close ALL dangling streaming assistant messages — not just the last
      // item: a notice/tool item appended after the assistant text would
      // otherwise leave it stuck in raw streaming mode (invisible text).
      state.items = state.items.map((it) =>
        it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it,
      );
      // A subagent row must never survive the run at ◐: `agent_end` is the
      // authoritative close, but a child killed before its first step (abort
      // during spawn) emits nothing — without this the sidebar shows
      // "running" forever and the run looks stuck.
      if (state.subagents.some((s) => s.status === "running")) {
        state.subagents = state.subagents.map((s) =>
          s.status === "running" ? { ...s, status: "failed", summary: s.summary ?? "run ended — subagent stopped" } : s,
        );
      }
      pushLog(state, "run", `${state.status} · ${state.step} steps · ${ev.summary.slice(0, 60)}`);
      break;
    }
    case "warmup": {
           if (ev.active) {
             state.warmup = { active: true, stage: ev.stage, percent: Math.max(0, Math.min(100, ev.percent)), message: ev.message ?? null };
             // One line per STAGE; ticks of the same stage fold in (`×N`) so
             // every warmup event is represented without 200 progress rows.
             foldLog(state, "evt", `warmup:${ev.stage}`, `warmup ${ev.stage} ${Math.max(0, Math.min(100, ev.percent))}%`);
           } else {
             if (state.warmup?.active) pushLog(state, "evt", "warmup idle");
             state.warmup = null;
           }
           break;
         }
    case "error": {
      appendItem(state, { kind: "notice", text: ev.message, level: "error" });
      pushLog(state, "evt", `error: ${ev.message}`, { meta: { exit: false } });
      break;
    }
  }
  return state;
}

/** Mark the current run aborted from the UI side (before the finish event). */
export function markAborted(state: TuiState): TuiState {
  state.status = "aborted";
  state.summary = "abort requested…";
  state.endedAt = Date.now();
  const last = lastItem(state);
  if (last && last.kind === "assistant" && last.streaming) {
    patchItem(state, state.items.length - 1, { streaming: false });
  }
  pushLog(state, "run", "abort requested");
  return state;
}
