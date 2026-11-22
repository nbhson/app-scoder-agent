/**
 * I-09/P2: subagent (task tool) runner extracted from the Agent constructor.
 *
 * runOne + batch runner were ~140 lines of closure living inside a 200-line
 * constructor — the Agent class is injected through `createAgent` so this
 * module has NO runtime import of ../agent.js (no import cycle; the child
 * surface is typed structurally as SubagentChild).
 */
import { discoverAgents, subagentDefs } from "../context/agents.js";
import type { AgentConfig } from "../config/config.js";
import type { PermissionAnswer } from "../security/permissions.js";
import type { TaskRunner, ToolResult } from "../tools/types.js";
import type { AgentEvent, AgentRunResult } from "./types.js";

/** The public surface of a child Agent the runner needs. */
export interface SubagentChild {
  readonly id: string;
  onEvent: ((ev: AgentEvent) => void) | null;
  run(task: string): Promise<AgentRunResult>;
  abort(): void;
  dispose(): void;
  resolvePermission(id: string, answer: PermissionAnswer): void;
}

export interface SubagentRunnerRuntime {
  /** Resolved PARENT config — children are spawned from it. */
  config: AgentConfig;
  /** Parent's run signal is REPLACED per run (resetRunSignal) — getter. */
  getRunSignal: () => AbortController;
  parentId: () => string;
  emit: (event: AgentEvent) => void;
  /** Char budget the parent grants each child summary (limits.maxOutputChars). */
  summaryBudget: () => number;
  createAgent: (config: AgentConfig) => SubagentChild;
  /** Registry the parent routes tagged permission answers through (T-03). */
  registerChild: (id: string, child: SubagentChild) => void;
  unregisterChild: (id: string) => void;
}

export function createTaskRunner(rt: SubagentRunnerRuntime): TaskRunner {
  /** Run one subtask in its own child Agent. */
  const runOne = async (args: { description?: string; prompt?: string; agent?: string }): Promise<ToolResult> => {
    const runSignal = rt.getRunSignal();
    // Already interrupted (Esc landed while this tool call was being set
    // up): spawning now would produce a child nobody can abort later.
    if (runSignal.signal.aborted) {
      return { ok: false, output: "ERROR: run was interrupted — subagent not spawned." };
    }
    // Spawnable set = mode subagent|all, non-hidden — user-defined
    // subagents are visible here (they were the whole point of the mode).
    const usable = subagentDefs(discoverAgents(rt.config.workdir));
    const def = args.agent ? usable.find((a) => a.name === args.agent) ?? null : usable.find((a) => a.name === "explore") ?? null;
    if (args.agent && !def) {
      return { ok: false, output: `ERROR: agent "${args.agent}" not found or not a subagent — available: ${usable.map((a) => a.name).join(", ")}` };
    }
    const child = rt.createAgent({
      ...rt.config,
      allowSubagents: false,
      programmaticSubagent: true, // def-mode warning is for user selections only
      parentSignal: runSignal.signal, // survives the child's resetRunSignal()
      // v2: the child resolves this def itself (tools filter, permission,
      // model via routing + def.model, prompt) — no manual overrides here.
      agent: def?.name ?? "build",
      // Subagents are step-unlimited: the run ends on completion, guardrail
      // stop, or parent abort — no artificial 20-step cap. A def that
      // declares `steps:` keeps its explicit budget.
      maxSteps: def?.steps ?? Number.POSITIVE_INFINITY,
      noSave: true, // subagent runs are ephemeral — no session pollution
    });
    // Abort cascade: parent abort kills child's in-flight LLM calls.
    // Removed in `finally` — long runs spawn many children and each
    // closure pins its (disposed) child Agent until the run ends.
    const childId = child.id;
    const onParentAbort = () => child.abort();
    runSignal.signal.addEventListener("abort", onParentAbort, { once: true });
    rt.registerChild(childId, child);
    const description = typeof args.description === "string" && args.description.trim()
      ? args.description.trim()
      : `subagent ${def?.name ?? "task"}`;
    rt.emit({
      type: "agent_start",
      id: childId,
      parentId: rt.parentId(),
      name: def?.name ?? "task",
      description,
      model: def?.model ?? rt.config.model,
    });
    // Event relay: child activity appears as subagent-tagged tool output.
    // permission_request MUST be forwarded (T-03): the child's broker
    // awaits that promise — dropping it here freezes the subagent for the
    // full 60–120s permission timeout with no modal ever shown. Ids are
    // tagged `<childId>:perm-N` so resolvePermission() routes the answer
    // back to the right child's broker.
    const childName = def?.name ?? "task";
    const tag = `subagent:${childName}`;
    // Emitted under the parent tool name "task": the TUI reducer
    // correlates tool_output to the running card BY NAME — a custom
    // "subagent:*" tag left the task card streaming nothing.
    let relayTextOpen = false; // streamed prose not yet terminated by a newline
    child.onEvent = (ev) => {
      if (ev.type === "tool_call") {
        rt.emit({ type: "tool_output", name: "task", stream: "stdout", delta: `${relayTextOpen ? "\n" : ""}→ ${childName}: ${ev.name}\n` });
        relayTextOpen = false;
      } else if (ev.type === "llm_delta") {
        rt.emit({ type: "tool_output", name: "task", stream: "stdout", delta: ev.delta });
        relayTextOpen = ev.delta.length > 0;
      } else if (ev.type === "permission_request") {
        rt.emit({ ...ev, id: `${childId}:${ev.id}`, label: `[${tag}] ${ev.label}` });
      }
    };
    try {
      const res = await child.run(args.prompt ?? "");
      rt.emit({ type: "agent_end", id: childId, ok: res.success, steps: res.steps, summary: res.summary.slice(0, 500) });
      // P2-limit: the child's summary goes straight into the PARENT's
      // conversation — an unbounded one (a chatty explore run) blows the
      // parent's context budget. Respect the parent's output allowance
      // (limits.maxOutputChars, same cap tool results obey) with an
      // explicit truncation marker so the parent knows to re-read files.
      const summaryCap = rt.summaryBudget();
      const summary = res.summary.length > summaryCap
        ? `${res.summary.slice(0, summaryCap - 120)}\n…[subagent summary truncated: ${res.summary.length} chars, kept ${summaryCap - 120} — read the relevant files directly for details]`
        : res.summary;
      return {
        ok: res.success,
        output: res.success
          ? `[subagent ${def?.name ?? "task"} done — ${res.steps} steps]\n${summary}`
          : `[subagent ${def?.name ?? "task"} FAILED — ${res.steps} steps]\n${summary}`,
      };
    } catch (err) {
      const msg = (err as Error).message;
      rt.emit({ type: "agent_end", id: childId, ok: false, steps: 0, summary: msg.slice(0, 500) });
      return { ok: false, output: `ERROR: subagent failed: ${msg}` };
    } finally {
      rt.unregisterChild(childId);
      runSignal.signal.removeEventListener("abort", onParentAbort);
      child.onEvent = null; // break child→parent relay reference
      // Child agents are ephemeral: close their MCP connections (if any).
      child.dispose();
    }
  };

  return async (ctx, args) => {
    if (ctx.allowSubagents === false) {
      return { ok: false, output: "ERROR: task tool not available — subagents cannot spawn further subagents (depth limit)." };
    }
    // Batch mode: bounded concurrency (max 4 in flight), stable result order.
    if (Array.isArray(args.tasks) && args.tasks.length > 0) {
      const tasks = args.tasks;
      const results: ToolResult[] = new Array(tasks.length);
      const concurrency = Math.min(4, tasks.length);
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const i = cursor++;
          if (i >= tasks.length) return;
          // Per-task catch: one bad task (e.g. child construction throw)
          // must not reject Promise.all and discard sibling results.
          results[i] = await runOne(tasks[i]).catch((err: unknown) => ({
            ok: false,
            output: `ERROR: task ${i + 1} failed: ${(err as Error).message ?? String(err)}`,
          }));
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      const okCount = results.filter((r) => r.ok).length;
      const body = results
        .map((r, i) => `## Task ${i + 1}: ${tasks[i].description}\n${r.output}`)
        .join("\n\n");
      return {
        ok: okCount === tasks.length,
        output: `[batch ${tasks.length} task${tasks.length === 1 ? "" : "s"} — ${okCount}/${tasks.length} ok]\n\n${body}`,
      };
    }
    if (typeof args.prompt !== "string" || !args.prompt.trim()) {
      return { ok: false, output: "ERROR: task requires a non-empty `prompt`." };
    }
    return runOne(args).catch((err: unknown) => ({
      ok: false,
      output: `ERROR: subagent failed: ${(err as Error).message ?? String(err)}`,
    }));
  };
}
