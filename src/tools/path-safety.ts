import { realpathSync } from "node:fs";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import type { ToolResult } from "./types.js";

export let MAX_OUTPUT_CHARS = 20_000;
export function setMaxOutputChars(n: number): void {
  if (Number.isFinite(n) && n > 0) MAX_OUTPUT_CHARS = Math.floor(n);
}

export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // refuse to read files > 2MB

export function clamp(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated, ${s.length - max} more chars]`;
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
