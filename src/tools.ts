import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, basename, join, relative, isAbsolute, sep } from "node:path";
import type { ToolSpec } from "./llm.js";
import { unifiedDiff } from "./diff.js";
import { detectImageBytes } from "./tui/image.js";
import type { DiffResult } from "./diff.js";
import type { PermissionChecker, PermissionMode } from "./permissions.js";
import { discoverSkills, findSkill } from "./skills.js";
import { redactSecrets } from "./llm.js";
import { loadRcFile } from "./config.js";
import { resolveSandbox, type SandboxConfig } from "./sandbox.js";
import * as ui from "./ui.js";
import { toolWebFetch } from "./webfetch.js";

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

function toolReadFile(workdir: string, args: { path: string }): ToolResult {
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
  const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
  return { ok: true, output: clamp(numbered) };
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

  const diff = unifiedDiff(args.path, content, newContent);
  const gate = await gateWrite(ctx, args.path, diff);
  if (gate) return gate;

  writeFileSync(abs, newContent, "utf8");
  const fmtNote = formatFile(ctx, abs);
  return {
    ok: true,
    output: `Edited ${args.path}${fmtNote ? `\n${fmtNote}` : ""}`,
    diff: toToolDiff(args.path, diff),
  };
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
export function toolGrep(workdir: string, args: { pattern: string; path?: string; include?: string }): ToolResult {
  return toResult(() => {
    const pattern = String(args.pattern ?? "").trim();
    if (!pattern) return { ok: false, output: "ERROR: pattern is required." };
    const root = safePath(workdir, args.path ?? ".");

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
    if (args.include) rgArgs.push("-g", args.include);
    const rg = spawnSync("rg", rgArgs, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const lines: string[] = [];
    let count = 0;
    if ((rg.status ?? 2) === 0 || rg.stdout) {
      for (const line of rg.stdout.split("\n")) {
        if (!line || count >= MAX_SEARCH_HITS) break;
        try {
          const j = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
          if (j.type !== "match" || !j.data) continue;
          const rel = relative(workdir, j.data.path?.text ?? "").split(sep).join("/");
          lines.push(`${rel}:${j.data.line_number}: ${(j.data.lines?.text ?? "").trimEnd().slice(0, 200)}`);
          count++;
        } catch { /* skip malformed */ }
      }
      if ((rg.status ?? 2) <= 1) {
        return { ok: true, output: lines.length > 0 ? clamp(lines.join("\n")) : "(no matches)" };
      }
      // status >= 2 → rg error; fall through to grep fallback.
    }

    // Fallback: grep -rn (portable) — output already path:line:text.
    const g = spawnSync("grep", ["-rn", "--binary-files=without-match", "-I", "-m", "5", "-e", pattern, root], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if ((g.status ?? 2) <= 1) {
      const hits = (g.stdout ?? "").split("\n").filter(Boolean).slice(0, MAX_SEARCH_HITS)
        .map((l) => l.startsWith(root) ? relative(workdir, root).split(sep).join("/") + l.slice(root.length) : l);
      return { ok: true, output: hits.length > 0 ? clamp(hits.join("\n")) : "(no matches)" };
    }
    // rg vắng mặt + grep vắng mặt/lỗi → scan JS thuần (luôn chạy được, không cần binary).
    return jsGrepFallback(workdir, root, pattern, args.include);
  });
}

/**
 * Fallback cuối: scan dòng thuần JS (không cần rg/grep). Kém tối ưu hơn rg
 * (không tôn trọng .gitignore ngoài SEARCH_SKIP, không lazy) nhưng luôn chạy
 * — quan trọng trên Windows máy chưa cài ripgrep. Pattern là regex JS; regex
 * không hợp lệ → coi như literal substring.
 */
function jsGrepFallback(workdir: string, root: string, pattern: string, include?: string): ToolResult {
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
  walkFiles(root, (_name, abs) => {
    if (hits.length >= MAX_SEARCH_HITS) return;
    const rel = relative(workdir, abs).split(sep).join("/");
    if (includeRx && !includeRx.test(rel)) return;
    try {
      const st = statSync(abs);
      if (st.size > 2 * 1024 * 1024) return; // skip file quá lớn
      const buf = readFileSync(abs);
      if (buf.includes(0)) return; // skip binary (NUL byte)
      const lines = buf.toString("utf8").split("\n");
      let perFile = 0;
      for (let i = 0; i < lines.length && perFile < 5 && hits.length < MAX_SEARCH_HITS; i++) {
        if (rx.test(lines[i])) {
          hits.push(`${rel}:${i + 1}: ${lines[i].trimEnd().slice(0, 200)}`);
          perFile++;
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
}

/** One row of the agent's session plan (write_todos). */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
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
        name: "load_skill",
        description:
          "Load the full instructions of a named skill from the AVAILABLE SKILLS index (project + global). Call this at the start of a task when it matches a skill, then follow the returned instructions exactly.",
        parameters: obj(
          { name: str("Skill name from the AVAILABLE SKILLS index, e.g. 'prompt-gate-workflow'") },
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
      return { ok: true, output: `# skill: ${skill.name} (${skill.scope})\n\n${skill.body}` };
    },
  },
  {
    spec: {
      type: "function",
      function: {
        name: "write_todos",
        description:
          "Write the full task plan (replaces the previous list). Use at the start of a multi-step task and update as you go: mark items completed IMMEDIATELY after finishing them, set exactly one item in_progress, and add newly discovered steps. The user sees this list live.",
        parameters: obj(
          {
            todos: {
              type: "array",
              description: "The complete todo list (full replacement).",
              items: {
                type: "object",
                properties: {
                  content: { type: "string", description: "Imperative step, e.g. 'Fix null check in UserService'" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
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
      for (const t of todos) {
        if (typeof t?.content !== "string" || !t.content.trim()) {
          return { ok: false, output: "ERROR: every todo needs a non-empty content string." };
        }
        if (!["pending", "in_progress", "completed"].includes(t.status)) {
          return { ok: false, output: `ERROR: invalid status "${String(t.status)}" (pending|in_progress|completed).` };
        }
        clean.push({ content: t.content.trim().slice(0, 200), status: t.status });
      }
      ctx.plan?.set(clean);
      const done = clean.filter((t) => t.status === "completed").length;
      return { ok: true, output: `Plan updated: ${done}/${clean.length} completed.` };
    },
  },
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
        description: "Read a text file. Returns content with 1-based line numbers. Image files (PNG/JPG/GIF) return an `[image: path]` placeholder rendered inline by the TUI.",
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
          "Run a shell command in the working directory (sh/bash -c; Windows: Git Bash when installed, else cmd /c). Use for builds, tests, git, installing deps, etc.",
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
          "Search file contents with a regex (ripgrep-backed, gitignore-aware). Returns path:line:text hits, max 50. " +
          "Use for finding code by symbol, error string, or pattern. Combine with read_file for context.",
        parameters: obj(
          {
            pattern: str("Regular expression to search for"),
            path: str("Directory or file to search (default: workdir root)"),
            include: str("Glob filter for filenames, e.g. '*.ts'"),
          },
          ["pattern"],
        ),
      },
    },
    run: (ctx, args) => toolGrep(ctx.workdir, args as { pattern: string; path?: string; include?: string }),
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
];

/** I-06: subagent spawner — injected by agent.ts (avoids circular import). */
export type TaskRunner = (
  ctx: ToolContext,
  args: { description: string; prompt: string; agent?: string },
) => Promise<ToolResult>;

/** task tool — runner resolved from ctx.taskRunner (per-agent, no global). */
const taskTool: AgentTool = {
  spec: {
    type: "function",
    function: {
      name: "task",
      description:
        "Delegate a self-contained subtask to a subagent that runs its own agent loop with its own context. " +
        "WHEN TO USE: broad codebase exploration (find where X lives, summarize module Y) so the main " +
        "conversation stays lean, or an independent subtask that needs many steps. " +
        "The prompt must be self-contained (the subagent sees nothing else); it returns a summary. " +
        "Prefer this over reading dozens of files yourself.",
      parameters: obj(
        {
          description: str("One-line summary of the subtask (shown in the UI)"),
          prompt: str("Self-contained instructions for the subagent, including any file paths and the expected output"),
          agent: str("Optional agent name from the available agents (default: explore for research, build for changes)"),
        },
        ["description", "prompt"],
      ),
    },
  },
  run: (ctx, args) => {
    if (!ctx.taskRunner) return { ok: false, output: "ERROR: task tool not wired (no runner in context)." };
    return ctx.taskRunner(ctx, args as { description: string; prompt: string; agent?: string });
  },
};

export function getTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.spec.function.name === name) ?? (name === "task" ? taskTool : undefined);
}

/** All tool specs incl. task (agent adds MCP specs on top). */
export function allToolSpecs(): ToolSpec[] {
  return [...AGENT_TOOLS.map((t) => t.spec), taskTool.spec];
}
