/**
 * v2 (3.2): Repo map — file tree + symbol outline injected into the system
 * prompt so the agent orients without reading half the repo first.
 *
 * Design:
 *  - No new dependencies: symbols are extracted with per-language regexes
 *    (tree-sitter is only a dependency for bash; TS grammars aren't present).
 *  - Budget-bounded: the map is capped by chars (~budgetChars ≈ budgetTokens
 *    × 4); deeper trees are truncated with a "… more files" marker.
 *  - Cached: .scoder/cache/repo-map.json keyed by a content signature
 *    (relpath + mtime of every walked file). Any edit invalidates the map.
 *  - Hidden + noise dirs skipped (node_modules/.git/dist/…, dot-dirs).
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv",
  "coverage", "out", "target", ".scoder", ".idea", ".vscode", "vendor",
]);
const SYMBOL_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs)$/i;
const MAX_WALK_FILES = 2000;
const MAX_FILE_BYTES = 150 * 1024;
const MAX_SYMBOLS_PER_FILE = 8;
const DEFAULT_BUDGET_CHARS = 8000; // ~2k tokens

export interface WalkedFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/** Walk the workdir (bounded) collecting regular files, skipping noise dirs. */
export function walkRepo(workdir: string, sub = ".", maxFiles = MAX_WALK_FILES): WalkedFile[] {
  const out: WalkedFile[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith(".") && e.name !== ".github") continue; // hidden
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const abs = join(dir, e.name);
        try {
          const st = statSync(abs);
          out.push({ rel: relative(workdir, abs).split(sep).join("/"), abs, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // unreadable entry — skip
        }
      }
    }
  };
  walk(join(workdir, sub), 0);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** Content signature — changes iff any walked file's path or mtime changes. */
export function repoMapKey(workdir: string): string {
  const h = createHash("sha1");
  for (const f of walkRepo(workdir)) {
    h.update(`${f.rel}:${Math.floor(f.mtimeMs)};`);
  }
  return h.digest("hex");
}

// ── Symbol extraction (per-language regex, intentionally conservative) ───────

const PATTERNS: Array<{ rx: RegExp; group: number }> = [
  // TS/JS: export [default] [async] function|class|interface|type|enum|const…
  { rx: /(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class)\s*([A-Za-z_$][\w$]*)/g, group: 1 },
  { rx: /export\s+(?:declare\s+)?(?:const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, group: 1 },
  // Python
  { rx: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, group: 1 },
  { rx: /^\s*class\s+([A-Za-z_]\w*)/gm, group: 1 },
  // Go: func [(recv)] Name, type Name
  { rx: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, group: 1 },
  { rx: /^type\s+([A-Za-z_]\w*)/gm, group: 1 },
  // Rust: [pub] fn|struct|enum|trait Name
  { rx: /^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm, group: 1 },
  // Java/C#: class|interface Name
  { rx: /(?:class|interface|enum)\s+([A-Za-z_]\w*)/g, group: 1 },
];

export function extractSymbols(path: string, content: string): string[] {
  const out = new Set<string>();
  for (const { rx, group } of PATTERNS) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(content)) !== null && out.size < MAX_SYMBOLS_PER_FILE) {
      const sym = m[group];
      if (sym && !/^(if|for|while|switch|return|import|from|package)$/.test(sym)) out.add(sym);
    }
    if (out.size >= MAX_SYMBOLS_PER_FILE) break;
  }
  // Java/C# pattern matches keywords-ish names — filter common noise
  void path;
  return [...out].slice(0, MAX_SYMBOLS_PER_FILE);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function kb(size: number): string {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(size / 1024))}KB`;
}

/** Render the map without touching the cache (used for sub-tree maps). */
export function renderRepoMap(workdir: string, budgetChars = DEFAULT_BUDGET_CHARS, sub = "."): string {
  const files = walkRepo(workdir, sub);
  const lines: string[] = [
    `REPO MAP — ${files.length} files (auto-generated; orient from this, don't read everything)`,
  ];
  let budget = budgetChars;
  let shown = 0;
  let truncated = 0;
  for (const f of files) {
    let line = `  ${f.rel} (${kb(f.size)})`;
    if (SYMBOL_FILE.test(f.rel) && f.size <= MAX_FILE_BYTES) {
      try {
        const syms = extractSymbols(f.rel, readFileSync(f.abs, "utf8"));
        if (syms.length > 0) line += ` — ${syms.join(", ")}`;
      } catch {
        // unreadable — keep just the path
      }
    }
    if (budget - line.length - 1 < 0) {
      truncated++;
      continue; // keep counting for the "… more files" marker
    }
    lines.push(line);
    budget -= line.length + 1;
    shown++;
  }
  if (truncated > 0) lines.push(`  … ${truncated} more file(s) — use list_files/glob to explore`);
  return lines.join("\n");
}

function cacheFile(workdir: string): string {
  return join(workdir, ".scoder", "cache", "repo-map.json");
}

/**
 * Build (or reuse from cache) the repo map for the workdir root.
 * Cache lives in .scoder/cache/ — safe to delete at any time.
 */
export function buildRepoMap(workdir: string, budgetChars = DEFAULT_BUDGET_CHARS): string {
  let key = "";
  try {
    key = repoMapKey(workdir);
    const cached = JSON.parse(readFileSync(cacheFile(workdir), "utf8")) as { key?: string; map?: string };
    if (cached.key === key && typeof cached.map === "string") return cached.map;
  } catch {
    // no/invalid cache — rebuild
  }
  const map = renderRepoMap(workdir, budgetChars);
  try {
    mkdirSync(dirname(cacheFile(workdir)), { recursive: true });
    writeFileSync(cacheFile(workdir), JSON.stringify({ key, generatedAt: new Date().toISOString(), map }), "utf8");
  } catch {
    // cache is best-effort
  }
  return map;
}

/** Explicit invalidation (e.g. after /compact or a cache-clearing command). */
export function invalidateRepoMap(workdir: string): void {
  try {
    writeFileSync(cacheFile(workdir), "{}", "utf8");
  } catch {
    // ignore — the mtime key will catch any real change anyway
  }
}
