import { readdirSync, statSync } from "node:fs";
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

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length > 500) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e)) continue;
      if (!includeHidden && e.startsWith(".") && e !== ".github") continue;
      if (excludeRx?.test(e)) continue;
      const full = join(dir, e);
      let st;
      try {
        safePath(workdir, relative(workdir, full));
        st = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(workdir, full).split(sep).join("/");
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

// ---------------------------------------------------------------------------
// grep / glob (I-07)
// ---------------------------------------------------------------------------

