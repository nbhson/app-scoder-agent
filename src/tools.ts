import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname, basename, join, relative, isAbsolute } from "node:path";
import type { ToolSpec } from "./llm.js";
import { unifiedDiff } from "./diff.js";
import type { PermissionChecker, PermissionMode } from "./permissions.js";
import * as ui from "./ui.js";

/** Result of executing one tool. */
export interface ToolResult {
  ok: boolean;
  output: string;
}

const MAX_OUTPUT_CHARS = 20_000;
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // refuse to read files > 2MB

function clamp(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated, ${s.length - max} more chars]`;
}

/** Resolve a user-supplied path inside workdir; reject escapes and symlink traversal. */
function safePath(workdir: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(workdir, p);
  // Lexical containment first (cheap): reject obvious ../ escapes.
  const relLex = relative(workdir, abs);
  if (relLex.startsWith("..") || isAbsolute(relLex)) {
    throw new Error(`Path escapes working directory: ${p}`);
  }
  // Realpath containment: resolve symlinks so a link inside workdir pointing
  // outside (e.g. evil-link -> /etc) cannot be used to read/write outside.
  // macOS may present /tmp as /private/tmp — resolve workdir the same way.
  let realWorkdir = workdir;
  try {
    realWorkdir = realpathSync(workdir);
  } catch (err) {
    // workdir must exist; keep lexical fallback for a transient ENOENT,
    // but surface unexpected failures instead of silently swallowing them.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`Cannot resolve working directory "${workdir}": ${(err as Error).message}`, { cause: err });
    }
  }
  // Walk up to the nearest existing ancestor, then verify containment.
  let probe = abs;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      const reconstructed = real + missing.map((s) => `/${s}`).join("");
      const rel = relative(realWorkdir, reconstructed.length > 0 ? reconstructed : real);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path escapes working directory: ${p}`);
      }
      return abs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && probe !== dirname(probe)) {
        missing.push(basename(probe));
        probe = dirname(probe);
        continue;
      }
      // realpath failed for another reason (e.g. escaped) — rethrow escape errors
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/** Turn a sync tool step into a ToolResult, converting thrown errors (e.g. path escapes) into structured results. */
function toResult(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (err) {
    return { ok: false, output: `ERROR: ${(err as Error).message}` };
  }
}

function toolReadFile(workdir: string, args: { path: string }): ToolResult {
  return toResult(() => {
  const abs = safePath(workdir, args.path);
  const st = statSync(abs);
  if (st.isDirectory()) {
    return { ok: false, output: `ERROR: ${args.path} is a directory — use list_files instead.` };
  }
  if (st.size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      output: `ERROR: ${args.path} is ${(st.size / 1024 / 1024).toFixed(1)}MB (limit ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB). Use run_command with grep/head/tail to inspect specific parts.`,
    };
  }
  const content = readFileSync(abs, "utf8");
  const lines = content.split("\n");
  const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
  return { ok: true, output: clamp(numbered) };
  });
}

/** Shared permission/diff gate for file writes. Returns null = approved. */
async function gateWrite(
  ctx: ToolContext,
  path: string,
  oldContent: string | null,
  newContent: string,
): Promise<ToolResult | null> {
  const mode: PermissionMode = ctx.permissionMode ?? "auto";
  const diff = unifiedDiff(path, oldContent, newContent);

  if (mode === "readonly") {
    if (diff.text) ui.printDiff(diff.text);
    return {
      ok: false,
      output: `ERROR: readonly mode — write to ${path} denied. The diff above is shown for review only; nothing was written.`,
    };
  }

  if (mode === "ask" && ctx.permissions) {
    if (diff.text) ui.printDiff(diff.text);
    const allowed = await ctx.permissions.confirmEdit(path, diff.text);
    if (!allowed) {
      return { ok: false, output: `ERROR: user rejected the write to ${path}. Try a different approach or explain why it is needed.` };
    }
  } else if (diff.text && !diff.truncated) {
    ui.printDiff(diff.text);
  } else if (diff.truncated) {
    ui.diffSummary(path, diff.added, diff.removed);
  }

  return null;
}

async function toolWriteFile(ctx: ToolContext, args: { path: string; content: string }): Promise<ToolResult> {
  let abs: string;
  try {
    abs = safePath(ctx.workdir, args.path);
  } catch (err) {
    return { ok: false, output: `ERROR: ${(err as Error).message}` };
  }
  let oldContent: string | null = null;
  try {
    oldContent = readFileSync(abs, "utf8");
  } catch {
    // new file
  }

  const gate = await gateWrite(ctx, args.path, oldContent, args.content);
  if (gate) return gate;

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, args.content, "utf8");
  return { ok: true, output: `Wrote ${args.content.split("\n").length} lines to ${args.path}` };
}

async function toolEditFile(
  ctx: ToolContext,
  args: { path: string; old_string: string; new_string: string },
): Promise<ToolResult> {
  let abs: string;
  try {
    abs = safePath(ctx.workdir, args.path);
  } catch (err) {
    return { ok: false, output: `ERROR: ${(err as Error).message}` };
  }
  const content = readFileSync(abs, "utf8");
  if (!content.includes(args.old_string)) {
    return { ok: false, output: `old_string not found in ${args.path}. Read the file again and retry with exact text.` };
  }
  const count = content.split(args.old_string).length - 1;
  if (count > 1) {
    return { ok: false, output: `old_string matches ${count} locations in ${args.path}; include more surrounding context to make it unique.` };
  }
  // Function replacement: avoids JS $-pattern interpolation ($&, $', $`, $1…)
  // which would corrupt literal text like "$&" in the new content.
  const newContent = content.replace(args.old_string, () => args.new_string);

  const gate = await gateWrite(ctx, args.path, content, newContent);
  if (gate) return gate;

  writeFileSync(abs, newContent, "utf8");
  return { ok: true, output: `Edited ${args.path}` };
}

function toolListFiles(workdir: string, args: { path?: string }): ToolResult {
  return toResult(() => {
  const root = safePath(workdir, args.path ?? ".");
  const skip = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);
  const out: string[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 4 || out.length > 500) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e)) continue;
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(workdir, full);
      if (st.isDirectory()) {
        out.push(`${rel}/`);
        walk(full, depth + 1);
      } else {
        out.push(`${rel} (${st.size}b)`);
      }
      if (out.length > 500) {
        out.push("... [truncated]");
        return;
      }
    }
  };

  walk(root, 0);
  return { ok: true, output: out.length > 0 ? clamp(out.join("\n")) : "(empty directory)" };
  });
}

/**
 * Run a shell command asynchronously (async spawn keeps the event loop free,
 * so streaming output renders and SIGINT is handled promptly).
 * Kills the child on timeout or external abort (SIGINT via ctx.signal).
 */
export async function toolRunCommand(
  workdir: string,
  args: { command: string; timeout_secs?: number },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const timeoutMs = Math.min(Math.max(args.timeout_secs ?? 120, 1), 600) * 1000;

  return new Promise<ToolResult>((resolve) => {
    let settled = false;
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const child = spawn("/bin/sh", ["-c", args.command], {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedReason: "timeout" | "aborted" | null = null;

    const killChild = (reason: "timeout" | "aborted") => {
      killedReason = reason;
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      // SIGKILL fallback if the process ignores SIGTERM
      setTimeout(() => {
        try { if (child.exitCode === null) child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5_000).unref();
    };

    const timer = setTimeout(() => killChild("timeout"), timeoutMs);

    const onAbort = () => killChild("aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

    child.on("error", (err) => {
      finish({ ok: false, output: clamp(`$ ${args.command}\n(spawn error) ${err.message}`) });
    });

    child.on("close", (code) => {
      if (killedReason === "timeout") {
        finish({
          ok: false,
          output: clamp(`$ ${args.command}\n(command timed out after ${Math.round(timeoutMs / 1000)}s and was killed)\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`),
        });
        return;
      }
      if (killedReason === "aborted") {
        finish({
          ok: false,
          output: clamp(`$ ${args.command}\n(interrupted by user)\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`),
        });
        return;
      }
      const status = code ?? -1;
      if (status === 0) {
        finish({ ok: true, output: clamp(`$ ${args.command}\n(exit 0)\n${stdout}`) });
      } else {
        finish({
          ok: false,
          output: clamp(`$ ${args.command}\n(exit ${status})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`),
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export interface ToolContext {
  workdir: string;
  permissions?: PermissionChecker;
  permissionMode?: PermissionMode;
  /** Aborted on SIGINT — long-running commands observe this and terminate. */
  signal?: AbortSignal;
}

export interface AgentTool {
  spec: ToolSpec;
  run: (ctx: ToolContext, args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const str = (description: string) => ({ type: "string", description });

export const AGENT_TOOLS: AgentTool[] = [
  {
    spec: {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories recursively under a path in the working directory.",
        parameters: obj({ path: str("Relative path, defaults to '.'") }, []),
      },
    },
    run: (ctx, args) => toolListFiles(ctx.workdir, args as { path?: string }),
  },
  {
    spec: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file. Returns content with 1-based line numbers.",
        parameters: obj({ path: str("Relative file path") }, ["path"]),
      },
    },
    run: (ctx, args) => toolReadFile(ctx.workdir, args as { path: string }),
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
          "Replace an exact unique substring in a file. old_string must appear exactly once; include enough surrounding context.",
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
        name: "run_command",
        description:
          "Run a shell command (/bin/sh -c) in the working directory. Use for builds, tests, git, installing deps, etc.",
        parameters: obj(
          {
            command: str("Shell command to run"),
            timeout_secs: str("Timeout in seconds (default 120, max 600)"),
          },
          ["command"],
        ),
      },
    },
    run: (ctx, args) =>
      toolRunCommand(ctx.workdir, args as { command: string; timeout_secs?: number }, ctx.signal),
  },
];

export function getTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.spec.function.name === name);
}
