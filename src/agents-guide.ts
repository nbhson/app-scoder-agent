/**
 * v2 (3.2): AGENTS.md hierarchy — project/global conventions injected into
 * the system prompt instead of being rediscovered every run.
 *
 * Sources (in order of increasing specificity):
 *   1. ~/.scoder/AGENTS.md        — user-global conventions
 *   2. <workdir>/AGENTS.md        — repo root conventions
 *   3. <dir>/AGENTS.md            — nearest file walking up from each focus
 *      file mentioned in the task (e.g. src/tui/app.tsx → src/tui/, src/, root)
 *
 * Budgets: global + root ≤ 1200 chars each, nested ≤ 800 chars each,
 * total block ≤ 4000 chars. Content is wrapped in a clearly-delimited block
 * and marked "(project conventions — apply unless the task says otherwise)".
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";

export interface AgentGuide {
  /** Display path (absolute) for the source file. */
  source: string;
  content: string;
}

const GLOBAL_BUDGET = 1200;
const ROOT_BUDGET = 1200;
const NESTED_BUDGET = 800;
const TOTAL_BUDGET = 4000;

function readBudget(file: string, budget: number): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    const raw = readFileSync(file, "utf8").trim();
    if (!raw) return null;
    return raw.length <= budget ? raw : `${raw.slice(0, budget)}\n… [truncated — ${raw.length - budget} more chars]`;
  } catch {
    return null;
  }
}

const ROOT_NAMES = ["AGENTS.md", "AGENTS.local.md"];

function rootGuide(workdir: string): AgentGuide[] {
  const out: AgentGuide[] = [];
  const globalFile = join(homedir(), ".scoder", "AGENTS.md");
  const global = readBudget(globalFile, GLOBAL_BUDGET);
  if (global) out.push({ source: globalFile, content: global });
  for (const name of ROOT_NAMES) {
    const f = join(workdir, name);
    const content = readBudget(f, ROOT_BUDGET);
    if (content) { out.push({ source: f, content }); break; }
  }
  return out;
}

/** Nearest AGENTS.md at or above `focusFile`, stopping at workdir root. */
function nearestGuide(workdir: string, focusFile: string): AgentGuide | null {
  let dir = dirname(resolve(workdir, focusFile));
  const rootAbs = resolve(workdir);
  for (;;) {
    const root = normalize(rootAbs);
    const current = normalize(dir);
    if (current !== root && !current.startsWith(`${root}${sep}`)) return null;
    for (const name of ROOT_NAMES) {
      const f = join(dir, name);
      const content = readBudget(f, NESTED_BUDGET);
      if (content) return { source: f, content };
    }
    if (normalize(dir) === normalize(rootAbs)) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Extract path-like tokens from a task description (relative file mentions). */
export function extractFocusFiles(task: string, workdir: string): string[] {
  const FILE_EXTS = new Set([
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "rb", "php", "cs",
    "json", "yaml", "yml", "toml", "md", "sql", "sh", "css", "scss", "vue", "svelte", "html",
  ]);
  const out = new Set<string>();
  const rx = /(?:\.\.?\/|[\w-]+\/)*[\w-]+\.[A-Za-z][\w]{0,9}/g;
  for (const m of task.matchAll(rx)) {
    const p = m[0];
    const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
    if (!FILE_EXTS.has(ext)) continue;
    if (/^https?:/i.test(p)) continue;
    const abs = resolve(workdir, p);
    const rel = relative(workdir, abs);
    if (rel.startsWith("..") || /^[a-zA-Z]:/.test(rel)) continue;
    if (existsSync(abs)) out.add(rel.split(sep).join("/"));
    if (out.size >= 5) break;
  }
  return [...out];
}

/**
 * Collect the AGENTS.md chain for a task. `focusFiles` are relative paths
 * (typically extracted via extractFocusFiles). Order: global → root → nearest
 * nested (deduped by source). Total size capped at TOTAL_BUDGET.
 */
export function collectAgentGuides(workdir: string, focusFiles: string[] = []): AgentGuide[] {
  const guides: AgentGuide[] = [];
  const seen = new Set<string>();
  const push = (g: AgentGuide): boolean => {
    if (seen.has(g.source)) return false;
    seen.add(g.source);
    guides.push(g);
    return true;
  };
  for (const g of rootGuide(workdir)) push(g);
  for (const f of focusFiles) {
    const g = nearestGuide(workdir, f);
    if (g) push(g);
  }
  // Total budget cap — drop the oldest (least specific) first.
  let total = guides.reduce((n, g) => n + g.content.length, 0);
  while (guides.length > 1 && total > TOTAL_BUDGET) {
    const dropped = guides.shift();
    if (!dropped) break;
    total -= dropped.content.length;
  }
  return guides;
}

/**
 * Template written by /init — AGENTS.md starter. Detects project identity and
 * build/test commands from common manifest files; falls back to placeholders.
 */
export function agentsMdTemplate(workdir: string): string {
  let name = basename(workdir);
  let build = "npm run build";
  let test = "npm test";
  try {
    const pkg = JSON.parse(readFileSync(join(workdir, "package.json"), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (pkg.name) name = pkg.name;
    if (pkg.scripts?.build) build = "npm run build";
    if (pkg.scripts?.test) test = "npm test";
  } catch {
    // not a node project — keep generic placeholders
    if (existsSync(join(workdir, "go.mod"))) { build = "go build ./..."; test = "go test ./..."; }
    else if (existsSync(join(workdir, "Cargo.toml"))) { build = "cargo build"; test = "cargo test"; }
    else if (existsSync(join(workdir, "pyproject.toml"))) { build = "python -m compileall ."; test = "pytest"; }
    else if (existsSync(join(workdir, "Makefile"))) { build = "make"; test = "make test"; }
  }
  return `# ${name} — AGENTS.md

Conventions for AI coding agents working in this repository. Keep this file
accurate: update it when the build, tests, or architecture change.

## Project overview
<!-- One paragraph: what this project is, its main stack, and its layout. -->

## Commands
- Build: \`${build}\`
- Test: \`${test}\`
- Lint / typecheck: <!-- e.g. npm run lint && npm run typecheck -->

## Architecture map
<!-- Where the important things live: entry points, modules, data flow. -->

## Conventions
<!-- Code style, error-handling patterns, naming, test style, commit style. -->

## Guardrails
<!-- What agents must never do here (generated files, migrations, secrets…). -->
`;
}

/** Format the AGENTS.md block for the system prompt ("" when nothing found). */
export function buildAgentGuideBlock(workdir: string, task: string): string {
  const guides = collectAgentGuides(workdir, extractFocusFiles(task, workdir));
  if (guides.length === 0) return "";
  const parts = guides.map(
    (g) => `--- ${relative(workdir, g.source).split(sep).join("/") || g.source} ---\n${g.content}`,
  );
  return (
    `\n\nAGENTS.md (project conventions — apply unless the task explicitly says otherwise):\n` +
    parts.join("\n\n")
  );
}
