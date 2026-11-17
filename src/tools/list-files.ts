import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { safePath, toPosInt, toResult, clamp } from "./path-safety.js";
import { globToRegExp } from "./search.js";
import type { ToolResult } from "./types.js";

export function toolListFiles(
  workdir: string,
  args: { path?: string; depth?: number | string; exclude?: string; include_hidden?: string | boolean },
): ToolResult {
  return toResult(() => {
  const root = safePath(workdir, args.path ?? ".");
  const skip = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);
  // v2: configurable depth (default 4, cap 8), hidden-dotfiles opt-in, exclude globs.
  const maxDepth = Math.min(toPosInt(args.depth, 4), 8);
  const includeHidden = args.include_hidden === true || args.include_hidden === "true";
  const excludeRx = args.exclude
    ? new RegExp(
        args.exclude.split(/[,\s]+/).filter(Boolean)
          .map((g) => globToRegExp(g).source)
          .join("|"),
      )
    : null;
  const out: string[] = [];

  // P-perf (item 7): the old walk paid a `safePath` (full realpath chain) on
  // EVERY entry — hundreds of syscalls for a plain listing — only to reject
  // symlink escapes. readdirSync(withFileTypes) already knows the entry type
  // without a stat, and symlinks are simply NOT FOLLOWED: no traversal is
  // possible by construction, so the per-entry realpath is dead weight.
  // (Reads/writes that DO dereference a path still go through safePath.)
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length > 500) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      if (!includeHidden && e.name.startsWith(".") && e.name !== ".github") continue;
      if (excludeRx?.test(e.name)) continue;
      if (e.isSymbolicLink()) continue; // never traversed, never dereferenced
      const full = join(dir, e.name);
      const rel = relative(workdir, full).split(sep).join("/");
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        walk(full, depth + 1);
      } else {
        let st;
        try {
          st = statSync(full);
        } catch {
          continue; // raced with a delete — same as the old per-entry guard
        }
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

// ---------------------------------------------------------------------------
// grep / glob (I-07)
// ---------------------------------------------------------------------------

