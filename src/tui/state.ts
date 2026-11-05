/**
 * Pure event→state reducer for the Ink TUI (src/tui/app.tsx).
 *
 * Kept framework-free on purpose: the whole conversation model is derived from
 * AgentEvents (agent.onEvent), so it can be unit-tested without rendering and
 * mirrors how `scoder serve` consumes the same event stream.
 */
import type { AgentEvent } from "../agent.js";

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
  };
}

const MAX_ITEMS = 400;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_TEXT_CHARS = 40_000;

/**
 * T4: ước lượng chiều cao (rows) của một ChatItem khi render — dùng cho
 * virtualization (chỉ render window quanh viewport thay vì cap cứng).
 * Over-estimate nhẹ an toàn hơn under-estimate (viewport luôn đủ phủ).
 * ponytail: heuristic theo chars, không đo Ink thật — nâng cấp thành đo
 * height thật (useBoxMetrics per item) khi heuristic lệch đáng kể.
 */
export function estimateItemRows(item: ChatItem): number {
  switch (item.kind) {
    case "user":
      return 2 + Math.ceil(item.text.length / 80);
    case "assistant":
    case "thinking":
      return 1 + Math.ceil((item.text?.length ?? 0) / 80) + (item.text ? item.text.split("\n").length : 0);
    case "tool":
      return 1 + 2; // title + preview 2 lines
    case "compaction":
      return 1;
    case "diff":
      return 3 + Math.min(24, (item.text?.split("\n").length ?? 0)); // header + ≤24 lines + border
    case "todo":
      return 2 + item.items.length;
    case "build":
      return 1;
    case "notice":
      return 1 + Math.ceil(item.text.length / 2000);
  }
}

/**
 * T4: chọn window item để render: lấy từ cuối lên tới khi tổng rows ước
 * lượng ≥ viewportRows + margin (render dư phía trên để scroll mượt), nhưng
 * giữ toàn bộ khi tổng nhỏ. Trả về slice của items (không mutate).
 */
export function visibleWindow(
  items: ChatItem[],
  viewportRows: number,
  margin = 50,
): ChatItem[] {
  const budget = viewportRows + margin;
  let acc = 0;
  let start = items.length;
  while (start > 0 && acc < budget) {
    start--;
    acc += estimateItemRows(items[start]);
  }
  return start === 0 ? items : items.slice(start);
}

/**
 * Plan mới nhất cho sidebar — todo items được append mỗi lần update nhưng
 * sidebar chỉ cần snapshot hiện tại (last-wins), null khi chưa có plan.
 *
 * Reset realtime: mỗi lần user gửi message mới, plan reset — chỉ hiện plan
 * được viết SAU user message cuối cùng. Tránh stale plan từ task trước hiện
 * trong task mới.
 */
export function latestPlan(items: ChatItem[]): Extract<ChatItem, { kind: "todo" }> | null {
  // Tìm user message cuối cùng — plan chỉ reset tại đây.
  let lastUserIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user") { lastUserIdx = i; break; }
  }
  // Chỉ tìm todo SAU user cuối.
  for (let i = items.length - 1; i > lastUserIdx; i--) {
    if (items[i].kind === "todo") return items[i] as Extract<ChatItem, { kind: "todo" }>;
  }
  return null;
}

function appendItem(state: TuiState, item: ChatItem): void {
  state.items.push(item);
  if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS);
}

function lastItem(state: TuiState): ChatItem | undefined {
  return state.items[state.items.length - 1];
}

/** Cap long strings, keeping the tail (errors usually live at the end). */
function capTail(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `…[truncated ${text.length - max} chars]\n${text.slice(text.length - max)}`;
}

/**
 * Map tên tool → phase của breadcrumb (plan→explore→edit→build→verify).
 * Trả về null với tool không thuộc phase nào (mcp__*...).
 */
export function toolPhase(name: string): string | null {
  if (name === "write_todos") return "plan";
  if (name === "list_files" || name === "read_file" || name === "grep" || name === "glob" || name === "web_fetch" || name === "load_skill" || name === "repo_map") return "explore";
  if (name === "write_file" || name === "edit_file" || name === "apply_patch") return "edit";
  if (name === "run_command") return "build";
  if (name === "task") return "delegate";
  if (name === "ask_user") return "clear";
  if (name.startsWith("mcp__")) return "mcp";
  return null;
}

/** Guardrail event: đếm + giữ decision gần nhất (ngắn, tự giải thích cho header). */
function applyGuardrail(state: TuiState, ev: { rule: string; action: string; reason: string }): void {
  // history-trim là routine context management — đếm làm gì, hiện làm gì:
  // header chỉ hiển thị những can thiệp THẬT sự đáng chú ý (inject/finish/verify).
  if (ev.action === "trim") return;
  state.guardrailCount += 1;
  // Thông điệp thân thiện theo rule — không dump raw "rule · reason" lên UI.
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
}

/**
 * Fold one AgentEvent into the state (mutates `state`, returns it for
 * reducer-style chaining). Unknown events are ignored.
 */
export function applyEvent(state: TuiState, ev: AgentEvent): TuiState {
  switch (ev.type) {
    case "permission_request": {
      // T-03: surfaced via a dedicated React state hook in TuiApp (not the
      // chat items — the modal is modal, not transcript).
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
      // The TUI pushes the user's message itself when submitting; avoid a
      // duplicate when run_start carries the same task.
      const last = lastItem(state);
      if (!(last && last.kind === "user" && last.text === ev.task)) {
        appendItem(state, { kind: "user", text: ev.task });
      }
      break;
    }
    case "llm_reasoning": {
      // T-10: thinking stream — chỉ append khi thinkingVisible; vẫn giữ trong
      // reasoning buffer riêng để toggle bật lại thấy (đơn giản: drop khi off).
      if (!state.thinkingVisible) break;
      const last = lastItem(state);
      if (last && last.kind === "thinking" && last.streaming) {
        last.text += ev.delta;
        if (last.text.length > MAX_TEXT_CHARS) last.text = last.text.slice(-MAX_TEXT_CHARS);
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
      // A new step starts: close any still-"streaming" assistant message.
      const last = lastItem(state);
      if (last && last.kind === "assistant" && last.streaming) last.streaming = false;
      if (last && last.kind === "thinking" && last.streaming) last.streaming = false;
      break;
    }
    case "llm_delta": {
      if (state.streamStartedAt == null) {
        state.streamStartedAt = state.llmCallStartedAt ?? Date.now();
      }
      state.streamingOutputChars += ev.delta.length;
      const last = lastItem(state);
      if (last && last.kind === "assistant" && last.streaming) {
        last.text += ev.delta;
        if (last.text.length > MAX_TEXT_CHARS) last.text = last.text.slice(-MAX_TEXT_CHARS);
      } else {
        if (last && last.kind === "assistant" && last.streaming === false && last.text === "") {
          // reuse an empty assistant placeholder from a previous step
          last.streaming = true;
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
      if (start != null) {
        const elapsedMs = Math.max(1, Date.now() - start);
        const out = ev.usage.output_tokens ?? 0;
        if (out > 0) {
          state.lastLlmTokPerSec = Math.round(out / (elapsedMs / 1000));
        }
      }
      state.streamingOutputChars = 0;
      state.streamStartedAt = null;
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
      break;
    }
    case "tool_output": {
      // Live stdout/stderr chunks attach to the most recent running tool item.
      for (let i = state.items.length - 1; i >= 0; i--) {
        const it = state.items[i];
        if (it.kind === "tool" && it.ok === null && it.name === ev.name) {
          it.output += ev.delta;
          if (it.output.length > MAX_OUTPUT_CHARS) it.output = capTail(it.output);
          break;
        }
        // Stop searching at the previous tool boundary to avoid cross-attachment.
        if (it.kind === "tool") break;
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
          it.ok = ev.ok;
          if (it.startedAt != null) it.durationMs = Date.now() - it.startedAt;
          // Prefer the final (complete) result over accumulated live chunks.
          if (ev.output.length >= it.output.length) it.output = ev.output;
          if (ev.image) it.image = ev.image;
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
      }
      break;
    }
    case "build": {
      state.buildLamp = ev.success ? "ok" : "fail";
      if (state.phases[state.phases.length - 1] !== "verify") state.phases.push("verify");
      appendItem(state, { kind: "build", success: ev.success, command: ev.command });
      break;
    }
    case "todo": {
      // Plan updates render as a live checkbox list in the chat pane.
      appendItem(state, { kind: "todo", items: ev.items.map((t) => ({ ...t })) });
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
        break;
      }
      appendItem(state, { kind: "notice", text: ev.line, level: ev.line.includes("unavailable") ? "warn" : "info" });
      break;
    }
    case "steer_queued": {
      // Pending depth tracked via the absolute `queue` event; nothing else.
      state.queue = { ...state.queue, pending: state.queue.pending + 1, steering: state.queue.steering + (ev.mode === "steer" ? 1 : 0) };
      break;
    }
    case "steer_delivered": {
      state.queue = { pending: 0, steering: 0 };
      appendItem(state, { kind: "notice", text: `steer: ${ev.count} message(s) delivered`, level: "info" });
      break;
    }
    case "queue": {
      state.queue = { pending: ev.pending, steering: ev.steering };
      break;
    }
    case "compaction": {
      appendItem(state, { kind: "compaction", tokensBefore: ev.tokensBefore, tokensAfter: ev.tokensAfter, manual: ev.manual });
      break;
    }
    case "context": {
      state.context = { tokens: ev.tokens, window: ev.window, pct: ev.pct };
      break;
    }
    case "agent_start": {
      // Track in the tree list; rendering lands in the sidebar (Phase 7).
      const rest = state.subagents.filter((s) => s.id !== ev.id);
      rest.push({ id: ev.id, name: ev.name, description: ev.description, status: "running" });
      state.subagents = rest.slice(-20);
      break;
    }
    case "agent_end": {
      state.subagents = state.subagents.map((s) =>
        s.id === ev.id ? { ...s, status: ev.ok ? "ok" : "failed", steps: ev.steps, summary: ev.summary } : s,
      );
      break;
    }
    case "tool_progress": {
      // Attach latest progress message to the running tool card (if any).
      for (let i = state.items.length - 1; i >= 0; i--) {
        const it = state.items[i];
        if (it.kind === "tool" && it.ok === null && (it.callId === ev.id || it.name === ev.name)) {
          if (ev.message) it.output = capTail(`${it.output}\n… ${ev.message}`.trim());
          break;
        }
        if (it.kind === "tool") break;
      }
      break;
    }
    case "question_request": {
      // Surfaced via the dedicated ask_user modal (Phase 3/7); queue a notice
      // so the transcript isn't silent while waiting for user input.
      appendItem(state, { kind: "notice", text: `❓ ${ev.question}`, level: "info" });
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
      for (const it of state.items) {
        if (it.kind === "assistant" && it.streaming) it.streaming = false;
      }
      break;
    }
    case "error": {
      appendItem(state, { kind: "notice", text: ev.message, level: "error" });
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
  if (last && last.kind === "assistant") last.streaming = false;
  return state;
}
