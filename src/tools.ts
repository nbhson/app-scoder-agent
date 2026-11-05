import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, basename, join, relative, isAbsolute, sep } from "node:path";
import type { ToolSpec } from "./llm.js";
import { unifiedDiff } from "./diff.js";
import { detectImageBytes } from "./tui/image.js";
import type { DiffResult } from "./diff.js";
import type { PermissionChecker, PermissionMode } from "./permissions.js";
import { discoverSkills, findSkill, loadSkillSection } from "./skills.js";
import { redactSecrets } from "./llm.js";
import { loadRcFile } from "./config.js";
import { resolveSandbox, type SandboxConfig } from "./sandbox.js";
import * as ui from "./ui.js";
import { toolWebFetch } from "./webfetch.js";
import { buildRepoMap, renderRepoMap } from "./repo-map.js";

/** Structured diff attached to file-write tool results (for TUI / SSE rendering). */
export interface ToolDiff {
  path: string;
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

/** Result of executing one tool. */
export interface ToolResult {
  ok: boolean;
  output: string;
  /** Unified diff of the file change, when the tool modified a file. */
  diff?: ToolDiff;
  /** T7: data URL khi tool đọc được ảnh — TUI render halfblock, LLM nhận text. */
  image?: string;
  /** Phase 5: true for MCP tool/resource output (untrusted, third-party data). */
  untrusted?: boolean;
}

/**
 * G7: max chars tool output — default 20_000, runtime override qua
 * setMaxOutputChars (agent constructor gọi với config.limits).
 * ponytail: module-level mutable thay vì ctx param vào 12 call sites —
 * 1 agent/process đổi 1 lần lúc khởi tạo; đa-config cùng process (server mode)
 * chỉ cần giá trị giống nhau, nâng cấp thành ctx field khi có nhu cầu khác nhau.
 */
let MAX_OUTPUT_CHARS = 20_000;
export function setMaxOutputChars(n: number): void {
  if (Number.isFinite(n) && n > 0) MAX_OUTPUT_CHARS = Math.floor(n);
}
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

// H-04: protected files — read ⇒ ask (khi không allow rule), write luôn gate.
// `.env.example` và các biến thể template luôn được phép đọc.
const PROTECTED_READ_PATTERNS = [/^\.env$/, /\/\.env$/, /^\.env\.[^/]+$/, /\/\.env\.[^/]+$/];
const PROTECTED_READ_EXEMPT = [/^\.env\.example$/, /\/\.env\.example$/, /^\.env\.sample$/, /\/\.env\.sample$/, /^\.env\.template$/, /\/\.env\.template$/];

export function isProtectedEnvFile(relPath: string): "ask" | "allow" | null {
  if (PROTECTED_READ_EXEMPT.some((rx) => rx.test(relPath))) return "allow";
  if (PROTECTED_READ_PATTERNS.some((rx) => rx.test(relPath))) return "ask";
  return null;
}

/** Coerce a schema-provided numeric-ish arg to a positive int, else fallback. */
function toPosInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function toolReadFile(workdir: string, args: { path: string; offset?: number | string; limit?: number | string }): ToolResult {
  return toResult(() => {
  const abs = safePath(workdir, args.path);
  // H-04: .env read policy — ask trước khi trả nội dung (secrets hygiene).
  const rel = relative(workdir, abs);
  const envPolicy = isProtectedEnvFile(rel);
  if (envPolicy === "ask") {
    return {
      ok: false,
      output:
        `ASK_PERMISSION: ${rel} may contain secrets (env file). ` +
        `Ask the user to confirm before reading; suggest reading .env.example instead ` +
        `or running with a permission rule ({"action":"shell","resource":"read .env","effect":"allow"}).`,
    };
  }
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
  // T7: image file → base64 notice cho TUI render (LLM vẫn nhận mô tả text).
  let image: string | undefined;
  try {
    const probe = readFileSync(abs);
    const ext = detectImageBytes(probe);
    if (ext) image = `data:image/${ext};base64,${probe.toString("base64")}`;
  } catch {
    // not an image / unreadable — fall through to text read
  }
  if (image) {
    return { ok: true, output: `[image: ${args.path}]`, image };
  }
  const content = readFileSync(abs, "utf8");
  const lines = content.split("\n");
  const total = lines.length;
  // v2: line-range reads — offset (1-based, default 1) + limit (default all).
  const offset = Math.min(toPosInt(args.offset, 1), total);
  const limit = Math.min(toPosInt(args.limit, total - offset + 1), 2000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((l, i) => `${offset + i}: ${l}`).join("\n");
  const end = offset + slice.length - 1;
  const header = offset > 1 || end < total ? `[lines ${offset}-${end} of ${total} — ${args.path}]\n` : "";
  return { ok: true, output: clamp(header + numbered) };
  });
}

function toToolDiff(path: string, diff: DiffResult): ToolDiff | undefined {
  if (!diff.text && !diff.truncated) return undefined;
  return { path, text: diff.text, added: diff.added, removed: diff.removed, truncated: diff.truncated };
}

/** Shared permission/diff gate for file writes. Returns null = approved. */
async function gateWrite(
  ctx: ToolContext,
  path: string,
  diff: DiffResult,
): Promise<ToolResult | null> {
  const mode: PermissionMode = ctx.permissionMode ?? "auto";

  if (mode === "readonly") {
    if (diff.text) ui.printDiff(diff.text);
    return {
      ok: false,
      output: `ERROR: readonly mode — write to ${path} denied. The diff above is shown for review only; nothing was written.`,
      diff: toToolDiff(path, diff),
    };
  }

  if (mode === "ask" && ctx.permissions) {
    if (diff.text) ui.printDiff(diff.text);
    const allowed = await ctx.permissions.confirmEdit(path, diff.text);
    if (!allowed) {
      return {
        ok: false,
        output: `ERROR: user rejected the write to ${path}. Try a different approach or explain why it is needed.`,
        diff: toToolDiff(path, diff),
      };
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

  const diff = unifiedDiff(args.path, oldContent, args.content);
  const gate = await gateWrite(ctx, args.path, diff);
  if (gate) return gate;

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, args.content, "utf8");
  const fmtNote = formatFile(ctx, abs);
  return {
    ok: true,
    output: `Wrote ${args.content.split("\n").length} lines to ${args.path}${fmtNote ? `\n${fmtNote}` : ""}`,
    diff: toToolDiff(args.path, diff),
  };
}

/** v2: whitespace-insensitive regex for edit_file fuzzy fallback. */
function wsInsensitiveRegex(s: string): RegExp {
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
function applyOneEdit(
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
    // Function replacement: avoids JS $-pattern interpolation ($&, $', $`, $1…)
    // which would corrupt literal text like "$&" in the new content.
    return { ok: true, content: content.replace(oldString, () => newString), fuzzy: false };
  }
  // v2 fuzzy fallback: exact string missing → retry with whitespace-tolerant
  // matching (indent/trailing-space drift between model and file). Reports
  // ambiguity instead of guessing when multiple regions match.
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
  const outcome = applyOneEdit(content, args.path, args.old_string, args.new_string);
  if (!outcome.ok) return { ok: false, output: outcome.error };
  const newContent = outcome.content;

  const diff = unifiedDiff(args.path, content, newContent);
  const gate = await gateWrite(ctx, args.path, diff);
  if (gate) return gate;

  writeFileSync(abs, newContent, "utf8");
  const fmtNote = formatFile(ctx, abs);
  return {
    ok: true,
    output: `Edited ${args.path}${outcome.fuzzy ? " (fuzzy whitespace match)" : ""}${fmtNote ? `\n${fmtNote}` : ""}`,
    diff: toToolDiff(args.path, diff),
  };
}

async function toolApplyPatch(
  ctx: ToolContext,
  args: { path: string; edits: Array<{ old_string: string; new_string: string }> },
): Promise<ToolResult> {
  let abs: string;
  try {
    abs = safePath(ctx.workdir, args.path);
  } catch (err) {
    return { ok: false, output: `ERROR: ${(err as Error).message}` };
  }
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    return { ok: false, output: "ERROR: edits must be a non-empty array." };
  }
  if (args.edits.length > 50) {
    return { ok: false, output: `ERROR: too many edits (${args.edits.length}); split into chunks of at most 50.` };
  }
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    return { ok: false, output: `ERROR: cannot read ${args.path}: ${(err as Error).message}` };
  }
  const original = content;
  let fuzzy = 0;
  for (let i = 0; i < args.edits.length; i++) {
    const e = args.edits[i];
    if (!e || typeof e.old_string !== "string" || typeof e.new_string !== "string") {
      return { ok: false, output: `ERROR: edit #${i + 1} must have string old_string and new_string. No changes written.` };
    }
    const outcome = applyOneEdit(content, args.path, e.old_string, e.new_string);
    if (!outcome.ok) {
      return {
        ok: false,
        output: `ERROR: edit #${i + 1}/${args.edits.length} failed — ${outcome.error} No changes written.`,
      };
    }
    content = outcome.content;
    if (outcome.fuzzy) fuzzy++;
  }
  if (content === original) {
    return { ok: true, output: `No changes to ${args.path} (all edits were no-ops).` };
  }

  const diff = unifiedDiff(args.path, original, content);
  const gate = await gateWrite(ctx, args.path, diff);
  if (gate) return gate;

  writeFileSync(abs, content, "utf8");
  const fmtNote = formatFile(ctx, abs);
  const fuzzyNote = fuzzy > 0 ? ` (${fuzzy} fuzzy whitespace match${fuzzy === 1 ? "" : "es"})` : "";
  return {
    ok: true,
    output: `Applied ${args.edits.length} edit${args.edits.length === 1 ? "" : "s"} to ${args.path}${fuzzyNote}${fmtNote ? `\n${fmtNote}` : ""}`,
    diff: toToolDiff(args.path, diff),
  };
}

function toolListFiles(
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

const SEARCH_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);
const MAX_SEARCH_HITS = 50;

/** Walk files under root (bounded depth, skip noise dirs), collect relative paths. */
function walkFiles(root: string, cb: (rel: string, abs: string) => void, depth = 8): void {
  if (depth <= 0) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SEARCH_SKIP.has(e.name)) continue;
    const abs = join(root, e.name);
    if (e.isDirectory()) walkFiles(abs, cb, depth - 1);
    else if (e.isFile()) cb(e.name, abs);
  }
}

/** ripgrep if on PATH; else grep -rn; else JS line-scan fallback. Returns formatted hits. */
export function toolGrep(
  workdir: string,
  args: {
    pattern: string;
    path?: string;
    include?: string;
    context_before?: number | string;
    context_after?: number | string;
    max_results?: number | string;
    type?: string;
  },
): ToolResult {
  return toResult(() => {
    const pattern = String(args.pattern ?? "").trim();
    if (!pattern) return { ok: false, output: "ERROR: pattern is required." };
    const root = safePath(workdir, args.path ?? ".");
    // v2: context lines + hit cap — before/after look like ripgrep -B/-A.
    const ctxBefore = Math.min(toPosInt(args.context_before, 0), 20);
    const ctxAfter = Math.min(toPosInt(args.context_after, 0), 20);
    const maxResults = Math.min(toPosInt(args.max_results, MAX_SEARCH_HITS), 100);

    // Fast path: ripgrep (respects .gitignore, fast, JSON output). Skip
    // common noise dirs even when the project has no .gitignore.
    const rgArgs = [
      "--json", "--max-count", "5", "-e", pattern, root,
      // rg globs match the printed (absolute) path — bare dir name excludes it
      // anywhere in the tree; ** forms do NOT match absolute-path matches.
      "--glob", "!node_modules", "--glob", "!.git", "--glob", "!dist",
      "--glob", "!build", "--glob", "!.next", "--glob", "!__pycache__",
      "--glob", "!.venv",
    ];
    if (ctxBefore > 0) rgArgs.push("-B", String(ctxBefore));
    if (ctxAfter > 0) rgArgs.push("-A", String(ctxAfter));
    if (args.include) rgArgs.push("-g", args.include);
    if (args.type) rgArgs.push("--type", String(args.type));
    const rg = spawnSync("rg", rgArgs, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const lines: string[] = [];
    let count = 0;
    if ((rg.status ?? 2) === 0 || rg.stdout) {
      let prevLine = -1;
      let prevRel = "";
      for (const line of rg.stdout.split("\n")) {
        if (!line) continue;
        if (count >= maxResults) break;
        try {
          const j = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
          if (!j.data || (j.type !== "match" && j.type !== "context")) continue;
          const rel = relative(workdir, j.data.path?.text ?? "").split(sep).join("/");
          const ln = j.data.line_number ?? 0;
          const text = (j.data.lines?.text ?? "").trimEnd().slice(0, 200);
          // GNU-style: match lines keep ':' separators, context lines use '-'.
          if (rel !== prevRel || (prevLine >= 0 && ln > prevLine + 1)) {
            if (lines.length > 0) lines.push("--");
          }
          lines.push(`${rel}${j.type === "match" ? ":" : "-"}${ln}${j.type === "match" ? ":" : "-"} ${text}`);
          if (j.type === "match") count++;
          prevLine = ln;
          prevRel = rel;
        } catch { /* skip malformed */ }
      }
      if ((rg.status ?? 2) <= 1) {
        return { ok: true, output: lines.length > 0 ? clamp(lines.join("\n")) : "(no matches)" };
      }
      // status >= 2 → rg error; fall through to grep fallback.
    }

    // Fallback: grep -rn (portable) — output already path:line:text.
    const gArgs = ["-rn", "--binary-files=without-match", "-I", "-m", "5", "-e", pattern];
    if (ctxBefore > 0) gArgs.push("-B", String(ctxBefore));
    if (ctxAfter > 0) gArgs.push("-A", String(ctxAfter));
    gArgs.push(root);
    const g = spawnSync("grep", gArgs, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if ((g.status ?? 2) <= 1) {
      const hits = (g.stdout ?? "").split("\n").filter(Boolean);
      const out: string[] = [];
      let matches = 0;
      for (const l of hits) {
        // Context lines GNU-separated with '-'; matches with ':'.
        const isMatch = /^[^:]*:\d+:/.test(l);
        if (isMatch && matches >= maxResults) continue;
        if (isMatch) matches++;
        out.push(l.startsWith(root) ? relative(workdir, root).split(sep).join("/") + l.slice(root.length) : l);
      }
      return { ok: true, output: out.length > 0 ? clamp(out.join("\n")) : "(no matches)" };
    }
    // rg vắng mặt + grep vắng mặt/lỗi → scan JS thuần (luôn chạy được, không cần binary).
    return jsGrepFallback(workdir, root, pattern, args.include, ctxBefore, ctxAfter, maxResults);
  });
}

/**
 * Fallback cuối: scan dòng thuần JS (không cần rg/grep). Kém tối ưu hơn rg
 * (không tôn trọng .gitignore ngoài SEARCH_SKIP, không lazy) nhưng luôn chạy
 * — quan trọng trên Windows máy chưa cài ripgrep. Pattern là regex JS; regex
 * không hợp lệ → coi như literal substring.
 */
function jsGrepFallback(
  workdir: string,
  root: string,
  pattern: string,
  include?: string,
  ctxBefore = 0,
  ctxAfter = 0,
  maxResults = MAX_SEARCH_HITS,
): ToolResult {
  let rx: RegExp;
  try {
    rx = new RegExp(pattern);
  } catch {
    rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  const includeRx = include
    ? globToRegExp(include.includes("/") ? include : `**/${include}`)
    : null;
  const hits: string[] = [];
  let matches = 0;
  walkFiles(root, (_name, abs) => {
    if (matches >= maxResults) return;
    const rel = relative(workdir, abs).split(sep).join("/");
    if (includeRx && !includeRx.test(rel)) return;
    try {
      const st = statSync(abs);
      if (st.size > 2 * 1024 * 1024) return; // skip file quá lớn
      const buf = readFileSync(abs);
      if (buf.includes(0)) return; // skip binary (NUL byte)
      const lines = buf.toString("utf8").split("\n");
      // Collect matching line numbers, then emit merged windows with context.
      const matchIdx: number[] = [];
      for (let i = 0; i < lines.length && matchIdx.length < 5; i++) {
        if (rx.test(lines[i])) matchIdx.push(i);
      }
      if (matchIdx.length === 0) return;
      // Merge overlapping windows.
      const windows: Array<[number, number]> = [];
      for (const i of matchIdx) {
        const lo = Math.max(0, i - ctxBefore), hi = Math.min(lines.length - 1, i + ctxAfter);
        const last = windows[windows.length - 1];
        if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
        else windows.push([lo, hi]);
      }
      for (const [lo, hi] of windows) {
        if (hits.length > 0 && hits[hits.length - 1] !== "--") hits.push("--");
        for (let i = lo; i <= hi; i++) {
          const isMatch = matchIdx.includes(i);
          if (isMatch && matches >= maxResults) break;
          hits.push(`${rel}${isMatch ? ":" : "-"}${i + 1}${isMatch ? ":" : "-"} ${lines[i].trimEnd().slice(0, 200)}`);
          if (isMatch) matches++;
        }
      }
    } catch { /* unreadable — skip */ }
  });
  return { ok: true, output: hits.length > 0 ? clamp(hits.join("\n")) : "(no matches)" };
}

/** Mini glob: supports **, *, ?, {a,b}. Implemented over walkFiles (no deps). */
export function globToRegExp(pattern: string): RegExp {
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        rx += ".*";
        i++;
        if (pattern[i + 1] === "/") i++; // `**/` also matches zero dirs
      } else rx += "[^/]*";
    } else if (c === "?") rx += "[^/]";
    else if (c === "{") {
      // {a,b} → (a|b)
      const end = pattern.indexOf("}", i);
      const inner = pattern.slice(i + 1, end).replace(/,/g, "|");
      rx += `(${inner})`;
      i = end;
    } else rx += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`);
}

export function toolGlob(workdir: string, args: { pattern: string; path?: string }): ToolResult {
  return toResult(() => {
    const pattern = String(args.pattern ?? "").trim();
    if (!pattern) return { ok: false, output: "ERROR: pattern is required (e.g. 'src/**/*.ts')." };
    const root = safePath(workdir, args.path ?? ".");
    const rx = globToRegExp(pattern);
    const out: string[] = [];
    walkFiles(root, (_name, abs) => {
      // Pattern dùng '/' — normalize separator của OS (Windows trả '\') để khớp.
      const rel = relative(workdir, abs).split(sep).join("/");
      if (rx.test(rel) && out.length < MAX_SEARCH_HITS * 4) out.push(rel);
    });
    out.sort();
    return { ok: true, output: out.length > 0 ? clamp(out.join("\n")) : "(no files match)" };
  });
}

// ---------------------------------------------------------------------------
// Formatter post-edit (I-11)
// ---------------------------------------------------------------------------

const FORMATTER_TIMEOUT_MS = 30_000;

/**
 * Run the project formatter on a just-written file. Detection: `formatter`
 * config in ToolContext (true → auto-detect prettier/biome/denofmt from
 * node_modules; string → explicit binary/script). Fire-and-observe: errors
 * are appended to the tool output (LLM self-corrects), never thrown.
 */
function formatFile(ctx: ToolContext, abs: string): string | null {
  const fmt = ctx.formatter;
  if (!fmt) return null;
  let cmd: string[];
  if (typeof fmt === "string" && fmt !== "auto") {
    cmd = fmt.startsWith("npm:")
      ? ["npm", "run", fmt.slice(4), "--", abs]
      : [fmt, "--write", abs];
  } else {
    // auto-detect (formatter: true) — trên Windows, shim trong node_modules/.bin
    // là file .cmd (file không extension chỉ chạy được trên POSIX).
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
    // Windows: .cmd shim (npm.cmd, prettier.cmd) chỉ chạy được qua shell.
    shell: process.platform === "win32",
  });
  if (r.error) return `formatter notice: ${(r.error as Error).message.split("\n")[0]}`;
  if (r.status !== 0) {
    return `formatter notice: ${cmd[0]} exited ${r.status}\n${(r.stderr ?? r.stdout ?? "").slice(0, 500)}`;
  }
  return null;
}

/** Live output callback for run_command: called per chunk with its stream source. */
export type CommandOutputListener = (stream: "stdout" | "stderr", delta: string) => void;

// ── G3: child env allowlist ─────────────────────────────────────────────────
// spawn /bin/sh -c with the FULL process.env leaks every secret in the shell's
// environment (API keys, tokens) to any command the model runs — and thus to
// the conversation/log via `env` or a misbehaving tool. Allowlist instead.

/** Always passed through — minimum for node/python/git builds to work. */
const BASE_ENV_KEYS = [
  "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "SHELL", "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  // Windows essentiels — cmd.exe/npm.cmd cần SystemRoot/ComSpec/PATHEXT để chạy;
  // Node trên Windows tra env key không phân biệt hoa thường nên viết hoa cũng khớp.
  "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "WINDIR", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PUBLIC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
];

/**
 * G3: build the child env. Base keys + SCODER_* config + explicit extras from
 * the rc (`shellEnvAllow`), resolved from process.env. Missing keys are absent
 * (not empty) so tools detect them correctly.
 */
export function buildChildEnv(workdir: string, extraKeys?: string[]): Record<string, string> {
  const rc = loadRcFile(workdir) as { shellEnvAllow?: string[] };
  const allow = [...BASE_ENV_KEYS, ...(rc.shellEnvAllow ?? []), ...(extraKeys ?? [])];
  const out: Record<string, string> = {};
  for (const k of allow) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  // Windows + Git Bash: không có HOME — git/bash đọc config từ ~ (.gitconfig,
  // ssh keys). Map HOME → USERPROFILE để git hoạt động đúng user hiện tại.
  if (process.platform === "win32" && out.HOME === undefined && out.USERPROFILE) {
    out.HOME = out.USERPROFILE;
  }
  return out;
}

/**
 * Shell mặc định theo platform:
 * - Unix → /bin/sh -c.
 * - Windows → Git Bash nếu tìm thấy (model hay emit cú pháp POSIX: pipes, grep,
 *   rm -rf — cmd.exe không chạy được), fallback cmd.exe /d /c.
 *   KHÔNG dùng `where bash` — System32\bash.exe là WSL (sai filesystem).
 */
export function defaultShellArgv(command: string): string[] {
  if (process.platform === "win32") {
    const bash = findGitBash();
    if (bash) return [bash, "-c", command];
    return [process.env.ComSpec || process.env.COMSPEC || "cmd.exe", "/d", "/c", command];
  }
  return ["/bin/sh", "-c", command];
}

/** Locate Git for Windows' bash.exe (cached); null when not installed. */
let gitBashCache: string | null | undefined;
function findGitBash(): string | null {
  if (gitBashCache !== undefined) return gitBashCache;
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA;
  const candidates = [
    join(pf, "Git", "bin", "bash.exe"),
    join(pf86, "Git", "bin", "bash.exe"),
    ...(local ? [join(local, "Programs", "Git", "bin", "bash.exe")] : []),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      gitBashCache = c;
      return c;
    }
  }
  gitBashCache = null;
  return null;
}

/**
 * Run a shell command asynchronously (async spawn keeps the event loop free,
 * so streaming output renders and SIGINT is handled promptly).
 * Kills the child on timeout or external abort (SIGINT via ctx.signal).
 * When `onOutput` is provided, stdout/stderr chunks are forwarded live as they
 * arrive (in addition to being collected into the final ToolResult).
 * G3: output is redacted (secret shapes) before it enters the conversation,
 * the live stream, or the JSONL log.
 */
export async function toolRunCommand(
  workdir: string,
  args: { command: string; timeout_secs?: number },
  signal?: AbortSignal,
  onOutput?: (stream: "stdout" | "stderr", delta: string) => void,
  sandbox?: SandboxConfig,
): Promise<ToolResult> {
  const timeoutMs = Math.min(Math.max(args.timeout_secs ?? 120, 1), 600) * 1000;
  // G3: the echoed command line itself may contain a secret (e.g. `curl -H
  // "Authorization: Bearer sk-..."`) — redact the echo, never run redacted
  // (the child gets the raw command).
  const echoLine = `$ ${redactSecrets(args.command)}`;

  // G4: sandbox wrap khi config bật. Wrapper thiếu → warn + chạy trực tiếp.
  const sandboxed = await resolveSandbox(sandbox ?? {}, workdir, args.command);
  if (sandboxed.argv) {
    ui.info(`sandbox: ${sandboxed.wrapper} (${(sandbox ?? {}).mode})`);
  } else if ((sandbox ?? {}).mode && (sandbox ?? {}).mode !== "off") {
    ui.warn(`sandbox: ${sandboxed.reason}`);
  }
  const spawnArgv = sandboxed.argv ?? defaultShellArgv(args.command);

  return new Promise<ToolResult>((resolve) => {
    let settled = false;
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const child = spawn(spawnArgv[0], spawnArgv.slice(1), {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildChildEnv(workdir), // G3: allowlist — không kế thừa full process.env
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

    child.stdout?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stdout += s;
      onOutput?.("stdout", redactSecrets(s)); // G3
    });
    child.stderr?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stderr += s;
      onOutput?.("stderr", redactSecrets(s)); // G3
    });

    child.on("error", (err) => {
      finish({ ok: false, output: clamp(`${echoLine}\n(spawn error) ${err.message}`) });
    });

    child.on("close", (code) => {
      if (killedReason === "timeout") {
        finish({
          ok: false,
          output: clamp(`${echoLine}\n(command timed out after ${Math.round(timeoutMs / 1000)}s and was killed)\n--- stdout ---\n${redactSecrets(stdout)}\n--- stderr ---\n${redactSecrets(stderr)}`),
        });
        return;
      }
      if (killedReason === "aborted") {
        finish({
          ok: false,
          output: clamp(`${echoLine}\n(interrupted by user)\n--- stdout ---\n${redactSecrets(stdout)}\n--- stderr ---\n${redactSecrets(stderr)}`),
        });
        return;
      }
      const status = code ?? -1;
      // G3: redact trước khi output vào conversation/log/TUI.
      const redacted = redactSecrets(stdout);
      const redactedErr = redactSecrets(stderr);
      if (status === 0) {
        finish({ ok: true, output: clamp(`${echoLine}\n(exit 0)\n${redacted}`) });
      } else {
        finish({
          ok: false,
          output: clamp(`${echoLine}\n(exit ${status})\n--- stdout ---\n${redacted}\n--- stderr ---\n${redactedErr}`),
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
  /**
   * Live tool-output sink. run_command forwards stdout/stderr chunks here as
   * they arrive; the agent/UI (or the server event bus) decides how to render
   * or broadcast them. Only one tool runs at a time per agent.
   */
  onToolOutput?: (name: string, stream: "stdout" | "stderr", delta: string) => void;
  /**
   * Session plan store (write_todos tool). The agent owns persistence and
   * rendering; the tool is a pure CRUD surface.
   */
  plan?: {
    get(): TodoItem[];
    set(items: TodoItem[]): void;
  };
  /**
   * I-11: post-edit formatter. true = auto-detect (prettier/biome/eslint in
   * node_modules); string = binary path or "npm:<script>". Omit = off.
   */
  formatter?: boolean | string;
  /**
   * I-06/I-12: depth guard — false on subagent contexts so the task runner
   * refuses nested spawns (children inherit this via ctx).
   */
  allowSubagents?: boolean;
  /**
   * I-06 subagent runner — injected per-agent instance (no module-global
   * * state: two concurrent Agents each use their own runner; server-mode
   * multi-run safe).
   */
  taskRunner?: TaskRunner;
  /**
   * G4: sandbox config for run_command. Omit → off (chạy trực tiếp, hành vi
   * cũ). mode readonly/workspace-write → wrap qua sandbox-exec/bwrap/docker.
   */
  sandbox?: SandboxConfig;
  /** G7: max chars tool output (default 20_000) — clamp() đọc từ đây. */
  maxOutputChars?: number;
  /** v2: ask_user — frontends (TUI/REPL) provide a handler for interactive questions. */
  askUser?: (req: AskUserRequest) => Promise<{ ok: boolean; output: string }>;
}

/** v2: ask_user request shape. Frontends wire a handler via ctx.askUser. */
export interface AskUserRequest {
  question: string;
  options?: string[];
  multiple?: boolean;
  timeoutSecs?: number;
}

/** One row of the agent's session plan (write_todos). */
export interface TodoItem {
  /** Stable id — auto-assigned (t1…tn) when missing. Needed for depends_on. */
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** v2: how to verify the step (build/test command or observable behavior). */
  verify?: string;
  /** v2: ids of steps that must complete before this one. */
  depends_on?: string[];
  /** v2: files this step is expected to touch. */
  files?: string[];
  /** v2: acceptance criteria for the step to count as done. */
  acceptance?: string;
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
const num = (description: string) => ({ type: "number", description });

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

/** One subtask in a batch `task` call. */
export interface TaskSpec {
  description: string;
  prompt: string;
  agent?: string;
}

/** I-06: subagent spawner — injected by agent.ts (avoids circular import). */
export type TaskRunner = (
  ctx: ToolContext,
  args: { description?: string; prompt?: string; agent?: string; tasks?: TaskSpec[] },
) => Promise<ToolResult>;

/** task tool — runner resolved from ctx.taskRunner (per-agent, no global). */
const taskTool: AgentTool = {
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

export function getTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.spec.function.name === name) ?? (name === "task" ? taskTool : undefined);
}

/** All tool specs incl. task (agent adds MCP specs on top). */
export function allToolSpecs(): ToolSpec[] {
  return [...AGENT_TOOLS.map((t) => t.spec), taskTool.spec];
}
