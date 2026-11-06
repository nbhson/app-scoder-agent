import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DiffResult } from "../diff.js";
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

/** Run the project formatter on a just-written file. */
export function formatFile(ctx: ToolContext, abs: string): string | null {
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
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ctx.workdir,
    encoding: "utf8",
    timeout: FORMATTER_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (r.error) return `formatter notice: ${(r.error as Error).message.split("\n")[0]}`;
  if (r.status !== 0) {
    return `formatter notice: ${cmd[0]} exited ${r.status}\n${(r.stderr ?? r.stdout ?? "").slice(0, 500)}`;
  }
  return null;
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
  if (content.includes(oldString)) {
    const count = content.split(oldString).length - 1;
    if (count > 1) {
      return { ok: false, error: `old_string matches ${count} locations in ${path}; include more surrounding context to make it unique.` };
    }
    return { ok: true, content: content.replace(oldString, () => newString), fuzzy: false };
  }
  const all = [...content.matchAll(new RegExp(wsInsensitiveRegex(oldString).source, "g"))];
  if (all.length === 0) {
    return { ok: false, error: `old_string not found in ${path}. Read the file again and retry with exact text.` };
  }
  if (all.length > 1) {
    return { ok: false, error: `old_string not found exactly and ${all.length} whitespace-tolerant matches exist in ${path}; include more surrounding context to disambiguate.` };
  }
  return {
    ok: true,
    content: content.slice(0, all[0].index) + newString + content.slice(all[0].index + all[0][0].length),
    fuzzy: true,
  };
}
