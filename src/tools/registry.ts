import { findSkill, discoverSkills, loadSkillSection } from "../context/skills.js";
import { buildRepoMap, renderRepoMap } from "../context/repo-map.js";
import { toolWebFetch } from "./webfetch.js";
import { toolReadFile } from "./read-file.js";
import { toolWriteFile } from "./write-file.js";
import { toolEditFile } from "./edit-file.js";
import { toolApplyPatch } from "./apply-patch.js";
import { toolListFiles } from "./list-files.js";
import { toolGrep, toolGlob } from "./search.js";
import { toolRunCommand } from "./run-command.js";
import { taskTool } from "./task-tool.js";
import { obj, str, num } from "./schemas.js";
import type { AgentTool, TodoItem } from "./types.js";
import type { ToolSpec } from "../llm/llm.js";

export const AGENT_TOOLS: AgentTool[] = [
  {
    spec: {
      type: "function",
      function: {
        name: "load_skill",
        description:
          "Load the full instructions of a named skill from the AVAILABLE SKILLS index (project + global). Call this at the start of a task when it matches a skill, then follow the returned instructions exactly.",
        parameters: obj(
          {
            name: str("Skill name from the AVAILABLE SKILLS index, e.g. 'prompt-gate-workflow'"),
            section: str("Optional section heading to load (progressive disclosure). Omit for full body."),
          },
          ["name"],
        ),
      },
    },
    run: (ctx, args) => {
      const name = String((args as { name?: unknown }).name ?? "").trim();
      if (!name) return { ok: false, output: "ERROR: name is required — pick one from the AVAILABLE SKILLS index." };
      const skill = findSkill(ctx.workdir, name);
      if (!skill) {
        const names = discoverSkills(ctx.workdir).map((s) => s.name).join(", ");
        return { ok: false, output: `ERROR: skill "${name}" not found${names ? ` — available: ${names}` : " — no skills discovered"}.` };
      }
      const section = (args as { section?: unknown }).section;
      const body = section ? loadSkillSection(skill, String(section)) : skill.body;
      const refs = skill.references?.length ? `\n\nReferences: ${skill.references.join(", ")}` : "";
      return { ok: true, output: `# skill: ${skill.name} (${skill.scope})${skill.version ? ` v${skill.version}` : ""}\n\n${body}${refs}` };
    },
  },
  {
    spec: {
      type: "function",
      function: {
        name: "write_todos",
        description:
          "Write the full task plan (replaces the previous list). Use at the start of a multi-step task and update as you go: mark items completed IMMEDIATELY after finishing them, set exactly one item in_progress, and add newly discovered steps. " +
          "v2: each item may carry verify (how you will know it's done), depends_on (earlier step ids), files (expected paths) and acceptance (criteria). The user sees this list live.",
        parameters: obj(
          {
            todos: {
              type: "array",
              description: "The complete todo list (full replacement).",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Stable step id (e.g. 't1'). Auto-assigned when omitted." },
                  content: { type: "string", description: "Imperative step, e.g. 'Fix null check in UserService'" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                  verify: { type: "string", description: "How to verify the step — command or observable behavior" },
                  depends_on: { type: "array", items: { type: "string" }, description: "Ids of steps that must complete first" },
                  files: { type: "array", items: { type: "string" }, description: "Files this step is expected to touch" },
                  acceptance: { type: "string", description: "Criteria for the step to count as done" },
                },
                required: ["content", "status"],
                additionalProperties: false,
              },
            },
          },
          ["todos"],
        ),
      },
    },
    run: (ctx, args) => {
      const todos = (args as { todos?: TodoItem[] }).todos;
      if (!Array.isArray(todos)) return { ok: false, output: "ERROR: todos must be an array of {content, status}." };
      const clean: TodoItem[] = [];
      for (const [i, t] of todos.entries()) {
        if (typeof t?.content !== "string" || !t.content.trim()) {
          return { ok: false, output: "ERROR: every todo needs a non-empty content string." };
        }
        if (!["pending", "in_progress", "completed"].includes(t.status)) {
          return { ok: false, output: `ERROR: invalid status "${String(t.status)}" (pending|in_progress|completed).` };
        }
        const item: TodoItem = {
          id: typeof t.id === "string" && t.id.trim() ? t.id.trim().slice(0, 32) : `t${i + 1}`,
          content: t.content.trim().slice(0, 200),
          status: t.status,
        };
        if (typeof t.verify === "string" && t.verify.trim()) item.verify = t.verify.trim().slice(0, 300);
        if (typeof t.acceptance === "string" && t.acceptance.trim()) item.acceptance = t.acceptance.trim().slice(0, 300);
        if (Array.isArray(t.depends_on)) item.depends_on = t.depends_on.filter((x): x is string => typeof x === "string").slice(0, 10);
        if (Array.isArray(t.files)) item.files = t.files.filter((x): x is string => typeof x === "string").slice(0, 20);
        clean.push(item);
      }
      // v2 rule: exactly one in_progress at a time.
      const inProgress = clean.filter((t) => t.status === "in_progress");
      if (inProgress.length > 1) {
        return { ok: false, output: `ERROR: exactly one in_progress step allowed (got ${inProgress.length}: ${inProgress.map((t) => t.content).join(" | ")}). Mark the others pending or completed.` };
      }
      // v2 rule: depends_on must reference earlier ids in the SAME plan.
      const ids = new Set(clean.map((t) => t.id));
      for (const t of clean) {
        for (const dep of t.depends_on ?? []) {
          if (!ids.has(dep)) return { ok: false, output: `ERROR: step "${t.content}" depends_on unknown id "${dep}" — ids in this plan: ${[...ids].join(", ")}` };
        }
      }
      ctx.plan?.set(clean);
      const done = clean.filter((t) => t.status === "completed").length;
      const next = clean.find((t) => t.status === "in_progress");
      return { ok: true, output: `Plan updated: ${done}/${clean.length} completed.${next ? ` In progress: ${next.content}` : " (none in progress)"}` };
    },
  },
  {
    spec: {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories recursively under a path in the working directory. Hidden dotfiles are excluded unless include_hidden=true; pass depth / exclude to shape the output.",
        parameters: obj(
          {
            path: str("Relative path, defaults to '.'"),
            depth: num("Max directory depth to recurse (default 4, cap 8)"),
            exclude: str("Comma/space-separated globs to exclude, e.g. '*.log,coverage'"),
            include_hidden: str("'true' to include dotfiles (default: excluded)"),
          },
          [],
        ),
      },
    },
    run: (ctx, args) => toolListFiles(ctx.workdir, args as { path?: string; depth?: number; exclude?: string; include_hidden?: string | boolean }),
  },
  {
    spec: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file. Returns content with 1-based line numbers. Pass offset (1-based start line) and limit to read a slice instead of the whole file. Image files (PNG/JPG/GIF) return an `[image: path]` placeholder rendered inline by the TUI.",
        parameters: obj(
          {
            path: str("Relative file path"),
            offset: num("1-based line to start from (default: 1)"),
            limit: num("Max lines to read (default: whole file, capped at 2000)"),
          },
          ["path"],
        ),
      },
    },
    run: (ctx, args) => toolReadFile(ctx.workdir, args as { path: string; offset?: number; limit?: number }),
  },
  {
    spec: {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or overwrite a file with the given full content. Parent dirs are created automatically.",
        parameters: obj(
          { path: str("Relative file path"), content: str("Full file content") },
          ["path", "content"],
        ),
      },
    },
    run: (ctx, args) => toolWriteFile(ctx, args as { path: string; content: string }),
  },
  {
    spec: {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Replace an exact unique substring in a file. old_string must appear exactly once; include enough surrounding context. " +
          "For multiple replacements in the same file, use apply_patch (atomic, one write).",
        parameters: obj(
          {
            path: str("Relative file path"),
            old_string: str("Exact text to replace"),
            new_string: str("Replacement text"),
          },
          ["path", "old_string", "new_string"],
        ),
      },
    },
    run: (ctx, args) =>
      toolEditFile(ctx, args as { path: string; old_string: string; new_string: string }),
  },
  {
    spec: {
      type: "function",
      function: {
        name: "apply_patch",
        description:
          "Apply multiple exact replacements to ONE file atomically. Edits run in order; each old_string must match exactly once " +
          "in the content produced by the previous edits. If any edit fails, nothing is written. " +
          "Use this instead of repeated edit_file calls for multi-hunk changes.",
        parameters: obj(
          {
            path: str("Relative file path"),
            edits: {
              type: "array",
              description: "Ordered list of replacements applied atomically (1–50).",
              items: obj(
                {
                  old_string: str("Exact text to replace (must be unique at its turn)"),
                  new_string: str("Replacement text"),
                },
                ["old_string", "new_string"],
              ),
            },
          },
          ["path", "edits"],
        ),
      },
    },
    run: (ctx, args) =>
      toolApplyPatch(ctx, args as { path: string; edits: Array<{ old_string: string; new_string: string }> }),
  },
  {
    spec: {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a shell command in the working directory (sh/bash -c; Windows: Git Bash when installed, else cmd /c). Use for builds, tests, git, installing deps, etc.",
        parameters: obj(
          {
            command: str("Shell command to run"),
            timeout_secs: num("Timeout in seconds (default 120, max 600)"),
          },
          ["command"],
        ),
      },
    },
    run: (ctx, args) =>
      toolRunCommand(
        ctx.workdir,
        args as { command: string; timeout_secs?: number },
        ctx.signal,
        ctx.onToolOutput ? (stream, delta) => ctx.onToolOutput?.("run_command", stream, delta) : undefined,
        ctx.sandbox,
        ctx.reporter,
      ),
  },
  {
    spec: {
      type: "function",
      function: {
        name: "web_fetch",
        description:
          "Fetch a public HTTP(S) URL and return its content as readable plain text " +
          "(HTML converted to text, JSON pretty-printed). WHEN TO USE: the task depends on external, " +
          "possibly outdated knowledge — library/API documentation, an error message or comment " +
          "containing a URL, current package versions or changelogs, standards/specs. " +
          "WHEN NOT TO: the answer is already in the working directory or in the user's request; " +
          "you need a search engine (this tool fetches exact URLs only, it cannot search); " +
          "the content is a binary file (images, archives, PDFs are refused). " +
          "Private/internal addresses (localhost, 10.x, 192.168.x, 127.x) are blocked.",
        parameters: obj(
          {
            url: str("Absolute http(s) URL to fetch"),
            max_chars: str("Max characters of extracted content to return (default 20000, max 100000)"),
          },
          ["url"],
        ),
      },
    },
    run: (ctx, args) => toolWebFetch(ctx, args as { url: string; max_chars?: number }),
  },
  {
    spec: {
      type: "function",
      function: {
        name: "grep",
        description:
          "Search file contents with a regex (ripgrep-backed, gitignore-aware). Returns path:line:text hits (max 50 by default), with optional context lines and a hit cap. " +
          "Use for finding code by symbol, error string, or pattern. Combine with read_file for full context.",
        parameters: obj(
          {
            pattern: str("Regular expression to search for"),
            path: str("Directory or file to search (default: workdir root)"),
            include: str("Glob filter for filenames, e.g. '*.ts'"),
            context_before: num("Context lines to print before each match (default 0)"),
            context_after: num("Context lines to print after each match (default 0)"),
            max_results: num("Max matching lines to return (default 50, cap 100)"),
            type: str("ripgrep file type filter, e.g. 'ts', 'py' (rg only; ignored by fallbacks)"),
          },
          ["pattern"],
        ),
      },
    },
    run: (ctx, args) => toolGrep(ctx.workdir, args as {
      pattern: string; path?: string; include?: string;
      context_before?: number; context_after?: number; max_results?: number; type?: string;
    }),
  },
  {
    spec: {
      type: "function",
      function: {
        name: "glob",
        description:
          "Find files by glob pattern (supports **, *, ?, {a,b}). Returns matching paths sorted, max 200. " +
          "Use when you know the filename shape but not the location.",
        parameters: obj(
          {
            pattern: str("Glob pattern relative to workdir, e.g. 'src/**/*.ts'"),
            path: str("Directory to search (default: workdir root)"),
          },
          ["pattern"],
        ),
      },
    },
    run: (ctx, args) => toolGlob(ctx.workdir, args as { pattern: string; path?: string }),
  },
  {
    spec: {
      type: "function",
      function: {
        name: "repo_map",
        description:
          "Return the repository map — file tree with sizes + exported symbols (regex-extracted, budget-bounded, cached). " +
          "Use to orient before reading files; cheaper than listing/reading everything.",
        parameters: obj(
          { path: str("Sub-directory to map (default: repo root)") },
          [],
        ),
      },
    },
    run: (ctx, args) => {
      try {
        const sub = typeof (args as { path?: unknown }).path === "string" ? (args as { path: string }).path.trim() : "";
        const out = sub
          ? renderRepoMap(ctx.workdir, 4000, sub)
          : buildRepoMap(ctx.workdir);
        return { ok: true, output: out };
      } catch (err) {
        return { ok: false, output: `ERROR: repo map failed: ${(err as Error).message}` };
      }
    },
  },
];

export function getTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.spec.function.name === name) ?? (name === "task" ? taskTool : undefined);
}

/** All tool specs incl. task (agent adds MCP specs on top). */
export function allToolSpecs(): ToolSpec[] {
  return [...AGENT_TOOLS.map((t) => t.spec), taskTool.spec];
}
