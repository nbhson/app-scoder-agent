import type { TaskSpec, AgentTool } from "../tools/types.js";
import { obj, str } from "./schemas.js";

export const taskTool: AgentTool = {
  spec: {
    type: "function",
    function: {
      name: "task",
      description:
        "Delegate self-contained subtasks to subagents that run their own agent loop with their own context. " +
        "WHEN TO USE: broad codebase exploration (find where X lives, summarize module Y) so the main " +
        "conversation stays lean, or independent subtasks that need many steps. " +
        "SINGLE: pass description + prompt. BATCH: pass tasks[] to run up to 8 subtasks concurrently " +
        "(bounded at 4 in flight) and get one merged result. " +
        "Every prompt must be self-contained (the subagent sees nothing else); each returns a summary. " +
        "Prefer this over reading dozens of files yourself.",
      parameters: obj(
        {
          description: str("One-line summary of the subtask (single mode; shown in the UI)"),
          prompt: str("Self-contained instructions for the subagent (single mode)"),
          agent: str("Optional agent name from the available agents (default: explore for research, build for changes)"),
          tasks: {
            type: "array",
            description: "Batch mode: up to 8 subtasks run concurrently. When set, description/prompt are ignored.",
            items: obj(
              {
                description: str("One-line summary of this subtask (shown in the UI)"),
                prompt: str("Self-contained instructions for this subagent"),
                agent: str("Optional agent name for this subtask"),
              },
              ["description", "prompt"],
            ),
          },
        },
        [],
      ),
    },
  },
  run: (ctx, args) => {
    if (!ctx.taskRunner) return { ok: false, output: "ERROR: task tool not wired (no runner in context)." };
    const a = args as { description?: string; prompt?: string; agent?: string; tasks?: TaskSpec[] };
    if (Array.isArray(a.tasks) && a.tasks.length > 0) {
      if (a.tasks.length > 8) {
        return { ok: false, output: `ERROR: too many tasks (${a.tasks.length}); split into batches of at most 8.` };
      }
      const invalid = a.tasks.findIndex((t) => !t || typeof t.prompt !== "string" || !t.prompt.trim());
      if (invalid >= 0) return { ok: false, output: `ERROR: tasks[${invalid}] is missing a non-empty prompt.` };
      return ctx.taskRunner(ctx, { tasks: a.tasks });
    }
    if (typeof a.prompt !== "string" || !a.prompt.trim()) {
      return { ok: false, output: "ERROR: task requires a non-empty `prompt` (single mode) or a non-empty `tasks` array (batch mode)." };
    }
    return ctx.taskRunner(ctx, a);
  },
};

