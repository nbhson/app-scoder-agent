import { spawn } from "node:child_process";
import { Utf8Buffer } from "../shared/decode.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DiffResult } from "../workspace/diff.js";
import type { ToolContext, ToolResult, ToolDiff } from "./types.js";
import type { PermissionMode } from "../security/permissions.js";
import { consoleReporter } from "../io/console-reporter.js";

const FORMATTER_TIMEOUT_MS = 30_000;

export function toToolDiff(path: string, diff: DiffResult): ToolDiff | undefined {
  if (!diff.text && !diff.truncated) return undefined;
  return { path, text: diff.text, added: diff.added, removed: diff.removed, truncated: diff.truncated };
}

/** Shared permission/diff gate for file writes. Returns null = approved. */
export async function gateWrite(
  ctx: ToolContext,
  path: string,
  diff: DiffResult,
): Promise<ToolResult | null> {
  const mode: PermissionMode = ctx.permissionMode ?? "auto";

  if (mode === "readonly") {
    if (diff.text) (ctx.reporter ?? consoleReporter).printDiff(diff.text);
    return {
      ok: false,
      output: `ERROR: readonly mode — write to ${path} denied. The diff above is shown for review only; nothing was written.`,
      diff: toToolDiff(path, diff),
    };
  }

  if (mode === "ask" && ctx.permissions) {
    if (diff.text) (ctx.reporter ?? consoleReporter).printDiff(diff.text);
    const allowed = await ctx.permissions.confirmEdit(path, diff.text);
    if (!allowed) {
      return {
        ok: false,
        output: `ERROR: user rejected the write to ${path}. Try a different approach or explain why it is needed.`,
        diff: toToolDiff(path, diff),
      };
    }
  } else if (diff.text && !diff.truncated) {
    (ctx.reporter ?? consoleReporter).printDiff(diff.text);
  } else if (diff.truncated) {
    (ctx.reporter ?? consoleReporter).diffSummary(path, diff.added, diff.removed);
  }

  return null;
}

/**
 * Run the project formatter on a just-written file.
 *
 * P-perf: async (spawn) — `prettier --write` on a cold node_modules takes
 * 0,5–3s; as `spawnSync` it froze the ENTIRE process (TUI paint, SSE, LLM
 * stream parsing) inside the write tool. Same command resolution, same
 * timeout, same notice strings (the old r.error messages were "spawnSync
 * <cmd> …" — normalized back for byte-identical tool output).
 * All callers (write/edit/apply-patch tools) are async and awaited by the
 * tool-executor.
 */
export async function formatFile(ctx: ToolContext, abs: string): Promise<string | null> {
  const fmt = ctx.formatter;
  if (!fmt) return null;
  let cmd: string[];
  if (typeof fmt === "string" && fmt !== "auto") {
    cmd = fmt.startsWith("npm:")
      ? ["npm", "run", fmt.slice(4), "--", abs]
      : [fmt, "--write", abs];
  } else {
    const localBin = (name: string): string | null => {
      const base = join(ctx.workdir, "node_modules", ".bin", name);
      if (process.platform === "win32" && existsSync(`${base}.cmd`)) return `${base}.cmd`;
      if (existsSync(base)) return base;
      return null;
    };
    const prettier = localBin("prettier");
    const biome = localBin("biome");
    const eslint = localBin("eslint");
    if (prettier) cmd = [prettier, "--write", abs];
    else if (biome) cmd = [biome, "format", "--write", abs];
    else if (eslint) cmd = [eslint, "--fix", abs];
    else return null;
  }
  const r = await spawnCapture(cmd[0], cmd.slice(1), {
    cwd: ctx.workdir,
    timeout: FORMATTER_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (r.error) return `formatter notice: ${r.error.split("\n")[0]}`;
  if (r.status !== 0) {
    return `formatter notice: ${cmd[0]} exited ${r.status}\n${(r.stderr ?? r.stdout ?? "").slice(0, 500)}`;
  }
  return null;
}

function spawnCapture(
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; stdio: ["ignore", "pipe", "pipe"]; shell: boolean },
): Promise<{ status: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((res) => {
    let child;
    try {
      child = spawn(file, args, { ...opts, signal: AbortSignal.timeout(opts.timeout) });
    } catch (err) {
      res({ status: null, stdout: "", stderr: "", error: `spawnSync ${file} ${(err as Error).message}` });
      return;
    }
    // P1-15: decode across chunk boundaries (a formatter printing Vietnamese
    // or emoji used to land U+FFFD when a multi-byte char was split).
    const stdoutBuf = new Utf8Buffer(64_000);
    const stderrBuf = new Utf8Buffer(64_000);
    let spawnError: string | undefined;
    child.stdout?.on("data", (c: Buffer) => {
      stdoutBuf.push(c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderrBuf.push(c);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      // Normalize to the sync wording so tool output is byte-identical:
      // AbortSignal.timeout ⇒ AbortError, but spawnSync reported ETIMEDOUT.
      spawnError =
        err.code === "ABORT_ERR"
          ? `spawnSync ${file} ETIMEDOUT`
          : `spawnSync ${file} ${err.message.replace(/^spawn\s/, "spawnSync ")}`;
    });
    child.on("close", (code) => {
      res({ status: code, stdout: stdoutBuf.text, stderr: stderrBuf.text, ...(spawnError ? { error: spawnError } : {}) });
    });
  });
}

/** v2: whitespace-insensitive regex for edit_file fuzzy fallback. */
export function wsInsensitiveRegex(s: string): RegExp {
  let rx = "";
  for (const ch of s) {
    if (/\s/.test(ch)) rx += "\\s+";
    else rx += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(rx);
}

type EditOutcome =
  | { ok: true; content: string; fuzzy: boolean }
  | { ok: false; error: string };

/** Apply one exact (or whitespace-tolerant) replacement to in-memory content. */
export function applyOneEdit(
  content: string,
  path: string,
  oldString: string,
  newString: string,
): EditOutcome {
  if (typeof oldString !== "string" || oldString.length === 0) {
    return { ok: false, error: "old_string must be a non-empty string." };
  }
  // P-perf (item 8): occurrence counting via indexOf scan — `split(oldString)`
  // allocated the FULL fragment array (twice the file size in strings) just to
  // count matches, and the fuzzy path materialized every regex match through
  // `[...matchAll]` spread. Error texts below are byte-identical.
  const first = content.indexOf(oldString);
  if (first !== -1) {
    let count = 1;
    for (let idx = first + oldString.length; ;) {
      const next = content.indexOf(oldString, idx);
      if (next === -1) break;
      count++;
      idx = next + oldString.length;
    }
    if (count > 1) {
      return { ok: false, error: `old_string matches ${count} locations in ${path}; include more surrounding context to make it unique.` };
    }
    return { ok: true, content: content.slice(0, first) + newString + content.slice(first + oldString.length), fuzzy: false };
  }
  const rx = new RegExp(wsInsensitiveRegex(oldString).source, "g");
  let count = 0;
  let matchIndex = -1;
  let matchLength = 0;
  for (let m: RegExpExecArray | null; (m = rx.exec(content)) !== null; ) {
    count++;
    if (count === 1) {
      matchIndex = m.index;
      matchLength = m[0].length;
    }
    if (m.index === rx.lastIndex) rx.lastIndex++; // defensive: never spin on a zero-width match
  }
  if (count === 0) {
    return { ok: false, error: `old_string not found in ${path}. Read the file again and retry with exact text.` };
  }
  if (count > 1) {
    return { ok: false, error: `old_string not found exactly and ${count} whitespace-tolerant matches exist in ${path}; include more surrounding context to disambiguate.` };
  }
  return {
    ok: true,
    content: content.slice(0, matchIndex) + newString + content.slice(matchIndex + matchLength),
    fuzzy: true,
  };
}
