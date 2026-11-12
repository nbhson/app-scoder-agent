import { realpathSync } from "node:fs";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import type { ToolResult } from "./types.js";

export let MAX_OUTPUT_CHARS = 20_000;
export function setMaxOutputChars(n: number): void {
  if (Number.isFinite(n) && n > 0) MAX_OUTPUT_CHARS = Math.floor(n);
}

/**
 * P0-2 (RC-3): ngân sách ký tự cho MỘT tool result khi đẩy vào history.
 *
 * Khác MAX_OUTPUT_CHARS (chặn blob từ tool): con số này quyết định kích thước
 * nội dung model nhìn thấy mỗi bước. Với local model, mỗi 6k ký tự đọc thêm
 * ≈ 1.5k token và TOÀN BỘ số đó được re-prefill ở mọi lượt sau. read_file dùng
 * giá trị này để cắt theo DÒNG kèm hướng dẫn đọc tiếp (xem read-file.ts).
 */
export let MAX_TOOL_OUTPUT_CHARS = 6_000;
export function setMaxToolOutputChars(n: number): void {
  if (Number.isFinite(n) && n > 0) MAX_TOOL_OUTPUT_CHARS = Math.floor(n);
}

export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // refuse to read files > 2MB

/**
 * Cắt chuỗi theo ký tự, thêm marker số lượng còn lại. `hint` (P0-2) được gắn
 * vào marker để model biết CÁCH lấy phần còn lại (offset/limit) thay vì đoán —
 * đây chính là điểm commit aec95ef đã sửa (trunc mù → agent đọc lại/đổi chiến
 * lược, đốt thêm nhiều lượt).
 */
export function clamp(s: string, max = MAX_OUTPUT_CHARS, hint?: string): string {
  if (s.length <= max) return s;
  const tail = hint ? ` — ${hint}` : "";
  return s.slice(0, max) + `\n... [truncated, ${s.length - max} more chars${tail}]`;
}

/** Resolve a user-supplied path inside workdir; reject escapes and symlink traversal. */
export function safePath(workdir: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(workdir, p);
  const relLex = relative(workdir, abs);
  if (relLex.startsWith("..") || isAbsolute(relLex)) {
    throw new Error(`Path escapes working directory: ${p}`);
  }
  let realWorkdir = workdir;
  try {
    realWorkdir = realpathSync(workdir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`Cannot resolve working directory "${workdir}": ${(err as Error).message}`, { cause: err });
    }
  }
  let probe = abs;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      const reconstructed = real + [...missing].reverse().map((s) => `/${s}`).join("");
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
      throw err;
    }
  }
}

/** Turn a sync tool step into a ToolResult, converting thrown errors (e.g. path escapes) into structured results. */
export function toResult(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (err) {
    return { ok: false, output: `ERROR: ${(err as Error).message}` };
  }
}

const PROTECTED_READ_PATTERNS = [/^\.env$/, /\/\.env$/, /^\.env\.[^/]+$/, /\/\.env\.[^/]+$/];
const PROTECTED_READ_EXEMPT = [/^\.env\.example$/, /\/\.env\.example$/, /^\.env\.sample$/, /\/\.env\.sample$/, /^\.env\.template$/, /\/\.env\.template$/];

export function isProtectedEnvFile(relPath: string): "ask" | "allow" | null {
  if (PROTECTED_READ_EXEMPT.some((rx) => rx.test(relPath))) return "allow";
  if (PROTECTED_READ_PATTERNS.some((rx) => rx.test(relPath))) return "ask";
  return null;
}

/** Coerce a schema-provided numeric-ish arg to a positive int, else fallback. */
export function toPosInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}
