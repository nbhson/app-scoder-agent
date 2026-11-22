/**
 * T-01: `@` fuzzy autocomplete engine — pure logic, TUI-agnostic (unit-testable).
 * Sources: file index (.gitignore-aware via `rg --files`, fallback walk) +
 * directory prefixes so `@src/` opens the subtree. Engine: fuzzysort (MIT).
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import fuzzysort from "fuzzysort";
import { Utf8Buffer } from "../shared/decode.js";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

const TTL_MS = 5_000;

const cache = new Map<string, { files: string[]; built: number }>();

/**
 * File index for `workdir` (cached, TTL 5s; invalidateFileIndex on tool writes).
 * `force` (P1-2) bỏ qua cache — dùng cho fingerprint, nơi một file mới được tạo
 * bởi `run_command`/trình sửa ngoài PHẢI đổi hash, nếu không kết quả verify cũ
 * sẽ được tái sử dụng sai.
 */
export function fileIndex(workdir: string, force = false): string[] {
  const hit = cache.get(workdir);
  if (!force && hit && Date.now() - hit.built < TTL_MS) return hit.files;
  const files: string[] = [];
  // Fast path: ripgrep --files (gitignore-aware). Bare-name globs match at any
  // depth; `!**/x/**` does NOT match absolute paths (I-07 lesson).
  try {
    const r = spawnSync("rg", RG_FILES_ARGS(workdir), { maxBuffer: 16e6, timeout: 3_000 });
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
  cache.set(workdir, { files, built: Date.now() });
  return files;
}

function RG_FILES_ARGS(workdir: string): string[] {
  return ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules", "-g", "!dist", "-g", "!build", "-g", "!.venv", "-g", "!__pycache__", "-g", "!.next", "--no-messages", workdir];
}

/**
 * P-perf: stale-while-revalidate variant for the KEYSTROKE path (`@` overlay
 * in the TUI). The sync `fileIndex` above runs `spawnSync rg` inline when the
 * 5s TTL lapses — a 50–500 ms freeze exactly when the user types. This returns
 * the cached (possibly stale) index immediately and refreshes in the
 * background; the next keystroke sees the fresh list. Cold cache (nothing ever
 * built) still builds synchronously once — the TUI warms it at mount anyway.
 */
const revalidating = new Set<string>();

export function fileIndexStale(workdir: string): string[] {
  const hit = cache.get(workdir);
  if (!hit) return fileIndex(workdir);
  if (Date.now() - hit.built >= TTL_MS && !revalidating.has(workdir)) {
    revalidating.add(workdir);
    rgFilesAsync(workdir)
      .then((files) => {
        if (files && files.length > 0) {
          files.sort();
          cache.set(workdir, { files, built: Date.now() });
        } else {
          hit.built = Date.now(); // rg failed/empty — wait a TTL before retrying
        }
      })
      .finally(() => revalidating.delete(workdir));
  }
  return hit.files;
}

export function rgFilesAsync(workdir: string): Promise<string[] | null> {
  return new Promise((res) => {
    const child = spawn("rg", RG_FILES_ARGS(workdir));
    // P1-15: rg prints raw path bytes; a chunk split inside a multi-byte
    // directory name used to corrupt the index (and the split at "\n" then
    // matched a replacement character instead of the real path).
    const outBuf = new Utf8Buffer(16e6);
    let failed = false;
    child.stdout.on("data", (c: Buffer) => {
      outBuf.push(c);
    });
    child.stderr.resume();
    child.on("error", () => {
      failed = true;
      res(null); // no rg on PATH
    });
    child.on("close", (code) => {
      if (failed || code !== 0) return res(null);
      const files: string[] = [];
      for (const line of outBuf.text.split("\n")) {
        if (line) files.push(relative(workdir, line) || line);
      }
      res(files);
    });
  });
}

/** Cache invalidate — call after write/edit tool_result. P-perf (item 10):
 *  mark STALE instead of deleting, and scope to the modified workdir when
 *  known: `cache.clear()` also dropped OTHER workdirs (spawned sub-agents),
 *  and a full delete left the keystroke path (`fileIndexStale`) with no hit →
 *  the next `@` after any write ran `spawnSync rg` synchronously — a visible
 *  freeze exactly when the user types. With built=0 the sync builder still
 *  rebuilds on the next call (TTL check fails) while fileIndexStale serves the
 *  old list and refreshes asynchronously. Same freshness, no blocking. */
export function invalidateFileIndex(workdir?: string): void {
  if (workdir !== undefined) {
    const hit = cache.get(workdir);
    if (hit) hit.built = 0;
    return;
  }
  for (const hit of cache.values()) hit.built = 0;
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

/**
 * P-perf: candidate list + fuzzysort-prepared targets memoized by the index
 * array IDENTITY (the module cache hands back the same string[] until a
 * rebuild replaces it). The old code rebuilt the dirs Set and re-prepared
 * every target on EVERY keystroke — O(files × depth) + full fuzzysort.prepare
 * inside a useInput handler.
 */
interface PreparedIndex {
  candidates: string[];
  prepared: Fuzzysort.Prepared[];
}
const preparedMemo = new WeakMap<string[], PreparedIndex>();

function preparedIndex(files: string[]): PreparedIndex {
  const hit = preparedMemo.get(files);
  if (hit) return hit;
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const candidates = [...files, ...[...dirs].map((d) => `${d}/`)];
  const value: PreparedIndex = { candidates, prepared: candidates.map((c) => fuzzysort.prepare(c)) };
  try {
    preparedMemo.set(files, value);
  } catch {
    /* frozen array — không memo được, tính lại mỗi lần (đúng như trước) */
  }
  return value;
}

/** Candidate suggestions for a query: fuzzy files + dir prefixes, max 8. */
export function suggest(files: string[], query: string, limit = 8): string[] {
  const { candidates, prepared } = preparedIndex(files);
  if (query.includes("/") || query.endsWith("/")) {
    // Subtree mode: prefix match on directories (`@src/tui/…`).
    return candidates.filter((t) => t.startsWith(query)).slice(0, limit);
  }
  if (query === "") return candidates.slice(0, limit);
  return fuzzysort.go(query, prepared, { limit }).map((r) => r.target);
}

/** Replace the active @token with `sel` (dirs keep the trailing slash). */
export function applySuggestion(value: string, at: { start: number; query: string }, sel: string): string {
  return value.slice(0, at.start) + "@" + sel + (sel.endsWith("/") ? "" : " ");
}
