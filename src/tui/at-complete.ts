/**
 * T-01: `@` fuzzy autocomplete engine — pure logic, TUI-agnostic (unit-testable).
 * Sources: file index (.gitignore-aware via `rg --files`, fallback walk) +
 * directory prefixes so `@src/` opens the subtree. Engine: fuzzysort (MIT).
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import fuzzysort from "fuzzysort";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

let cache: { files: string[]; built: number } | null = null;

/** File index for `workdir` (cached, TTL 5s; invalidateFileIndex on tool writes). */
export function fileIndex(workdir: string): string[] {
  if (cache && Date.now() - cache.built < 5_000) return cache.files;
  const files: string[] = [];
  // Fast path: ripgrep --files (gitignore-aware). Bare-name globs match at any
  // depth; `!**/x/**` does NOT match absolute paths (I-07 lesson).
  try {
    const r = spawnSync(
      "rg",
      ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules", "-g", "!dist", "-g", "!build", "-g", "!.venv", "-g", "!__pycache__", "-g", "!.next", "--no-messages", workdir],
      { maxBuffer: 16e6, timeout: 3_000 },
    );
    if (r.status === 0) {
      for (const line of r.stdout.toString().split("\n")) {
        if (line) files.push(relative(workdir, line) || line);
      }
    }
  } catch {
    // no rg on PATH → walker fallback
  }
  if (files.length === 0) walkFiles(workdir, "", files, 0);
  files.sort();
  cache = { files, built: Date.now() };
  return files;
}

/** Cache invalidate — call after write/edit tool_result (scope: whole index). */
export function invalidateFileIndex(): void {
  cache = null;
}

function walkFiles(root: string, prefix: string, out: string[], depth: number): void {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(join(root, e.name), rel, out, depth + 1);
    else if (e.isFile()) out.push(rel);
  }
}

/** Active `@` token in `value`, or null. Returns start index (of "@") + query. */
export function atQuery(value: string): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(value);
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[2] };
}

/** Candidate suggestions for a query: fuzzy files + dir prefixes, max 8. */
export function suggest(files: string[], query: string, limit = 8): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const all = [...files, ...[...dirs].map((d) => `${d}/`)];
  let hits: string[];
  if (query.includes("/") || query.endsWith("/")) {
    // Subtree mode: prefix match on directories (`@src/tui/…`).
    hits = all.filter((t) => t.startsWith(query));
  } else if (query === "") {
    hits = all.slice(0, limit * 4);
  } else {
    hits = fuzzysort.go(query, all, { limit: limit * 4 }).map((r) => r.target);
  }
  return hits.slice(0, limit);
}

/** Replace the active @token with `sel` (dirs keep the trailing slash). */
export function applySuggestion(value: string, at: { start: number; query: string }, sel: string): string {
  return value.slice(0, at.start) + "@" + sel + (sel.endsWith("/") ? "" : " ");
}
