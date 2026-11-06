import type { AgentConfig } from "../config/config.js";
import type { ChatMessage } from "../llm/llm.js";
import type { BuildResult } from "../workspace/build.js";
import { EventSessionStore, SessionStore, type SessionFile } from "../session/session.js";
import { memoryFromMessages, type WorkingMemory } from "../context/memory.js";
import type { TodoItem } from "../tools.js";
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

/** Persist the v2 manifest and the legacy snapshot with their existing shapes. */
export function persistSession(
  runtime: PersistSessionRuntime,
  steps: number,
  buildCmd: string,
  lastBuild: BuildResult | null,
): void {
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
  return {
    messages,
    memory: memoryFromMessages(messages, session.task),
    plan,
    lastBuild: session.lastBuild
      ? { success: session.lastBuild.success, command: session.lastBuild.command, output: session.lastBuild.output }
      : null,
  };
}
