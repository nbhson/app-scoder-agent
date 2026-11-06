import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { safePath, clamp, toPosInt, toResult } from "./path-safety.js";
import type { ToolResult } from "./types.js";

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

