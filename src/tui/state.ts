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
      /** null = still running */
      ok: boolean | null;
      output: string;
      step: number;
    }
  | { kind: "notice"; text: string; level: "info" | "warn" | "error" }
  | { kind: "build"; success: boolean; command: string };

export type RunStatus = "idle" | "running" | "success" | "failed" | "aborted";

export interface TuiState {
  items: ChatItem[];
  status: RunStatus;
  step: number;
  maxSteps: number;
  model: string;
  provider: string;
  workdir: string;
  buildCmd: string;
  usage: { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number };
  summary: string | null;
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
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    summary: null,
  };
}

const MAX_ITEMS = 400;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_TEXT_CHARS = 40_000;

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
 * Fold one AgentEvent into the state (mutates `state`, returns it for
 * reducer-style chaining). Unknown events are ignored.
 */
export function applyEvent(state: TuiState, ev: AgentEvent): TuiState {
  switch (ev.type) {
    case "run_start": {
      state.model = ev.model;
      state.provider = ev.provider;
      state.workdir = ev.workdir;
      state.buildCmd = ev.buildCmd;
      state.status = "running";
      state.step = 0;
      state.summary = null;
      state.usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      // The TUI pushes the user's message itself when submitting; avoid a
      // duplicate when run_start carries the same task.
      const last = lastItem(state);
      if (!(last && last.kind === "user" && last.text === ev.task)) {
        appendItem(state, { kind: "user", text: ev.task });
      }
      break;
    }
    case "step": {
      state.step = ev.step;
      state.maxSteps = ev.maxSteps;
      // A new step starts: close any still-"streaming" assistant message.
      const last = lastItem(state);
      if (last && last.kind === "assistant" && last.streaming) last.streaming = false;
      break;
    }
    case "llm_delta": {
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
      break;
    }
    case "tool_call": {
      appendItem(state, { kind: "tool", name: ev.name, args: ev.args, ok: null, output: "", step: ev.step });
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
      for (let i = state.items.length - 1; i >= 0; i--) {
        const it = state.items[i];
        if (it.kind === "tool" && it.name === ev.name && it.ok === null) {
          it.ok = ev.ok;
          // Prefer the final (complete) result over accumulated live chunks.
          if (ev.output.length >= it.output.length) it.output = ev.output;
          break;
        }
      }
      break;
    }
    case "build": {
      appendItem(state, { kind: "build", success: ev.success, command: ev.command });
      break;
    }
    case "finish": {
      state.status = ev.success ? "success" : /interrupted|aborted/i.test(ev.summary) ? "aborted" : "failed";
      state.summary = ev.summary;
      // Close any dangling streaming assistant message.
      const last = lastItem(state);
      if (last && last.kind === "assistant") last.streaming = false;
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
  const last = lastItem(state);
  if (last && last.kind === "assistant") last.streaming = false;
  return state;
}
