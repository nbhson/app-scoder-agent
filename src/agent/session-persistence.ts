import type { AgentConfig } from "../config/config.js";
import type { ChatMessage } from "../llm/llm.js";
import type { BuildResult } from "../workspace/build.js";
import { EventSessionStore, SessionStore, type SessionFile } from "../session/session.js";
import { memoryFromMessages, setMemoryGoal, type WorkingMemory } from "../context/memory.js";
import type {TodoItem} from "../tools/types.js";
import type { UsageTotals } from "./types.js";

export interface PersistSessionRuntime {
  config: AgentConfig;
  events: EventSessionStore;
  session: SessionStore;
  currentTask: string;
  client: { model: string };
  messages: ChatMessage[];
  usageTotals: UsageTotals;
  sessionCreatedAt?: string;
}

/** Minimum gap between full snapshot/manifest writes during a run (P-perf item 2).
 *  Crash durability comes from the append-only event log (every message/tool
 *  event is fsync'd per line); the snapshot + manifest are READ-optimized
 *  projections, so re-writing the whole history mid-run more than every few
 *  seconds is pure I/O. Terminal paths pass `force: true`. */
const SNAPSHOT_MIN_MS = 5_000;
const lastSnapshotWrite = new WeakMap<object, number>();

function snapshotDue(store: object, force: boolean | undefined, now: number): boolean {
  if (force) return true;
  const last = lastSnapshotWrite.get(store) ?? 0;
  return now - last >= SNAPSHOT_MIN_MS;
}

/** Persist the v2 manifest and the legacy snapshot with their existing shapes. */
export function persistSession(
  runtime: PersistSessionRuntime,
  steps: number,
  buildCmd: string,
  lastBuild: BuildResult | null,
  opts: { force?: boolean } = {},
): void {
  // P-perf: one gate decision for BOTH projection writes (manifest + v1
  // snapshot) — skipped writes keep the event log authoritative; the next
  // due tick or any terminal path (finish/abort/max-steps) force-writes.
  const now = Date.now();
  if (!snapshotDue(runtime.session, opts.force, now) && !snapshotDue(runtime.events, opts.force, now)) return;
  lastSnapshotWrite.set(runtime.session, now);
  lastSnapshotWrite.set(runtime.events, now);
  const usage = {
    llmCalls: runtime.usageTotals.calls,
    inputTokens: runtime.usageTotals.inputTokens,
    outputTokens: runtime.usageTotals.outputTokens,
    cachedTokens: runtime.usageTotals.cachedTokens,
  };
  runtime.events.writeManifest({
    task: runtime.currentTask,
    model: runtime.client.model,
    provider: runtime.config.provider,
    buildCmd,
    steps,
    maxSteps: runtime.config.maxSteps,
    usage,
  });
  runtime.session.save(
    {
      task: runtime.currentTask,
      model: runtime.client.model,
      provider: runtime.config.provider,
      buildCmd,
      steps,
      maxSteps: runtime.config.maxSteps,
      messages: runtime.messages,
      lastBuild: lastBuild
        ? { success: lastBuild.success, command: lastBuild.command, output: lastBuild.output.slice(0, 10_000) }
        : null,
      usage,
    },
    runtime.sessionCreatedAt,
  );
}

export interface RestoredSessionState {
  messages: ChatMessage[];
  memory: WorkingMemory;
  plan: TodoItem[] | null;
  lastBuild: BuildResult | null;
}

/** Rebuild transient Agent state from a saved session without changing session data. */
export function restoreSessionState(session: SessionFile): RestoredSessionState {
  const messages = session.messages ?? [];
  let plan: TodoItem[] | null = null;
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const toolCall of message.tool_calls) {
      if (toolCall.name !== "write_todos") continue;
      try {
        const args = JSON.parse(toolCall.arguments) as { todos?: TodoItem[] };
        if (Array.isArray(args.todos)) plan = args.todos;
      } catch {
        // Skip malformed historical tool arguments.
      }
    }
  }
  // Goal là request HIỆN TẠI, không phải tin nhắn đầu phiên: ưu tiên quét history
  // (lấy request thật gần nhất), chỉ fallback `session.task` khi history đã bị trim.
  const memory = memoryFromMessages(messages);
  if (!memory.goal) setMemoryGoal(memory, session.task ?? "");
  return {
    messages,
    memory,
    plan,
    lastBuild: session.lastBuild
      ? { success: session.lastBuild.success, command: session.lastBuild.command, output: session.lastBuild.output }
      : null,
  };
}
