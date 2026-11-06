/**
 * v2 (3.5): Diagnostics — turn raw build/test/lint logs into structured
 * {file, line, severity, code, message} records, plus an error classifier
 * that maps a failure to a recovery strategy for the agent.
 *
 * Supported: tsc (both formats), eslint stylish/compact, pytest (tracebacks +
 * FAILED lines), go test, cargo, make. Unknown formats fall back to a generic
 * "error-ish line with a file(:line)? prefix" pattern. Output is deduplicated
 * and capped (30 diagnostics) so the agent gets a fixable list, not a log.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Diagnostic {
  file: string;
  line: number | null;
  severity: "error" | "warning" | "note";
  code: string | null;
  message: string;
  /** Which tool produced it (tsc | eslint | pytest | go | cargo | generic). */
  source: string;
}

export type ErrorKind = "syntax" | "type" | "test" | "runtime" | "permission" | "network" | "unknown";
export interface ErrorClassification {
  kind: ErrorKind;
  strategy: string;
}

const MAX_DIAGNOSTICS = 30;

function add(out: Diagnostic[], seen: Set<string>, d: Diagnostic): void {
  const key = `${d.file}:${d.line}:${d.code}:${d.message.slice(0, 80)}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (out.length < MAX_DIAGNOSTICS) out.push(d);
}

/** Parse a command output into structured diagnostics (best-effort). */
export function parseDiagnostics(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  let currentFile: string | null = null;
  let pendingCargo: { code: string | null; message: string } | null = null;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();

    let m: RegExpExecArray | null;

    // ── cargo (real output): error line, then "  --> file:line" on the NEXT line.
    if (pendingCargo) {
      m = /^\s*-->\s+([^\s:]+):(\d+)(?::\d+)?$/.exec(line);
      if (m) {
        add(out, seen, { file: m[1], line: Number(m[2]), severity: "error", code: pendingCargo.code, message: pendingCargo.message, source: "cargo" });
        pendingCargo = null;
        continue;
      }
      pendingCargo = null; // the error had no location line — drop it
    }

    // ── tsc (modern): src/foo.ts(12,5): error TS2322: message
    m = /^([^\s()][^()]*)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/.exec(line);
    if (m) {
      add(out, seen, { file: m[1], line: Number(m[2]), severity: m[4] === "warning" ? "warning" : "error", code: m[5], message: m[6].trim(), source: "tsc" });
      continue;
    }
    // ── tsc (new style): src/foo.ts:12:5 - error TS2322: message
    m = /^([^\s:][^:]*):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s*(.+)$/.exec(line);
    if (m) {
      add(out, seen, { file: m[1], line: Number(m[2]), severity: m[4] === "warning" ? "warning" : "error", code: m[5], message: m[6].trim(), source: "tsc" });
      continue;
    }
    // ── cargo: error[E0308]: msg  --> src/main.rs:10:5
    m = /^error(?:\[(E\d+)\])?:\s*(.+)\s+-->\s+([^\s:]+):(\d+)(?::\d+)?$/.exec(line);
    if (m) {
      add(out, seen, { file: m[3], line: Number(m[4]), severity: "error", code: m[1] ?? null, message: m[2].trim(), source: "cargo" });
      continue;
    }
    // ── cargo (2-line): "error[E0308]: msg" standing alone → expect --> next line.
    m = /^error(?:\[(E\d+)\])?:\s*(.+)$/.exec(line);
    if (m) {
      pendingCargo = { code: m[1] ?? null, message: m[2].trim() };
      continue;
    }
    // ── go vet/test: file.go:123: message   (also covers "# package" headers)
    m = /^([^\s:][^:()]*(?:\.go|\.py|\.rs|\.ts|\.tsx|\.js|\.mjs)):(\d+):\s+(.+)$/.exec(line);
    if (m && /error|fail|cannot|undefined|invalid|unexpected|panic/i.test(m[3])) {
      add(out, seen, { file: m[1], line: Number(m[2]), severity: "error", code: null, message: m[3].trim(), source: "generic" });
      continue;
    }
    // ── eslint stylish: "✖ N problems" ignored; file header then indented rows
    m = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}([\w-]+)$/.exec(line);
    if (m && currentFile) {
      add(out, seen, { file: currentFile, line: Number(m[1]), severity: m[3] as "error" | "warning", code: m[5], message: m[4].trim(), source: "eslint" });
      continue;
    }
    // eslint file header: /abs/path/file.ts  (a bare path on its own line)
    if (/^([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte))\s*$/.test(line.trim())) {
      currentFile = line.trim();
      continue;
    }
    // ── pytest: FAILED test_x.py::test_name - assert ...
    m = /^FAILED\s+([^\s:]+)(?:::[^\s]+)?(?:\s+-\s+(.+))?$/.exec(line);
    if (m) {
      add(out, seen, { file: m[1], line: null, severity: "error", code: "FAILED", message: (m[2] ?? "test failed").trim(), source: "pytest" });
      continue;
    }
    // pytest traceback frame: E   AssertionError: ...
    m = /^E\s+(.+)$/.exec(line);
    if (m) {
      add(out, seen, { file: "(pytest)", line: null, severity: "error", code: null, message: m[1].trim().slice(0, 200), source: "pytest" });
      continue;
    }
    // ── go test: --- FAIL: TestName
    m = /^--- FAIL:\s+([\w/]+)/.exec(line);
    if (m) {
      add(out, seen, { file: "(go test)", line: null, severity: "error", code: "FAIL", message: `test failed: ${m[1]}`, source: "go" });
      continue;
    }
    // ── make: make: *** [target] Error 2
    m = /^make(?:\[\d+\])?: \*\*\* \[([^\]]+)\] Error (\d+)/.exec(line);
    if (m) {
      add(out, seen, { file: "Makefile", line: null, severity: "error", code: `make:${m[2]}`, message: `target failed: ${m[1]}`, source: "make" });
      continue;
    }
  }
  return out;
}

/** Compact one-line-per-diagnostic rendering (prompt + UI friendly). */
export function formatDiagnostics(diags: Diagnostic[]): string {
  if (diags.length === 0) return "";
  const lines = diags.map(
    (d) => `- ${d.file}${d.line != null ? `:${d.line}` : ""} [${d.severity}${d.code ? ` ${d.code}` : ""}] ${d.message}`,
  );
  return `Diagnostics (${diags.length}):\n${lines.join("\n")}`;
}

/** Classify an error into a recovery strategy for the agent. */
export function classifyError(text: string): ErrorClassification {
  const t = text.toLowerCase();
  const has = (...pats: string[]) => pats.some((p) => t.includes(p));
  if (has("permission denied", "eacces", "denied by policy", "access is denied", "unauthorized", "403")) {
    return { kind: "permission", strategy: "do NOT retry the same command — use a safer alternative or report the limitation to the user." };
  }
  if (has("enotfound", "econnrefused", "etimedout", "network", "fetch failed", "eai_again", "econnreset", "401", "rate limit", "429")) {
    return { kind: "network", strategy: "check connectivity and credentials first (web_fetch/env), wait or pick another source; do not loop blindly." };
  }
  if (has("syntaxerror", "unexpected token", "unexpected end of", "parse error", "unterminated")) {
    return { kind: "syntax", strategy: "read the file around the indicated line and fix the syntax error directly." };
  }
  if (/ts\d{3,5}|type .{0,40}is not assignable|type mismatch|expected type|no compatible/.test(t)) {
    return { kind: "type", strategy: "read the failing type declaration and the usage site — fix the type, don't cast blindly." };
  }
  if (has("assertionerror", "assert failed", "expected", "to equal", "failed assert", "--- fail")) {
    return { kind: "test", strategy: "read the failing test, understand what it expects, then fix the implementation (or the test only if it is provably wrong)." };
  }
  if (has("typeerror", "referenceerror", "rangeerror", "panic", "nil pointer", "null pointer", "segmentation", "enoent")) {
    return { kind: "runtime", strategy: "read the stack trace, find the failing frame, and fix the root cause." };
  }
  return { kind: "unknown", strategy: "read the full error carefully; try a different approach or ask the user." };
}

// ── Verify command detection ─────────────────────────────────────────────────

export interface VerifyCommands {
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
}

/**
 * Detect verify commands for the workdir from manifests. rc override via
 * `verifyCmds` wins (empty string disables one).
 */
export function detectVerifyCmds(workdir: string): VerifyCommands {
  const out: VerifyCommands = {};
  try {
    const pkgPath = join(workdir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const s = pkg.scripts ?? {};
      if (s.build) out.build = "npm run build";
      if (s.test) out.test = "npm test";
      if (s.lint) out.lint = "npm run lint";
      if (s.typecheck) out.typecheck = "npm run typecheck";
      else if (s["type-check"]) out.typecheck = "npm run type-check";
    }
  } catch { /* malformed package.json — fall through */ }
  try {
    if (existsSync(join(workdir, "pyproject.toml"))) out.test = out.test ?? "pytest";
    if (existsSync(join(workdir, "Cargo.toml"))) {
      out.build = out.build ?? "cargo build";
      out.test = out.test ?? "cargo test";
    }
    if (existsSync(join(workdir, "go.mod"))) {
      out.build = out.build ?? "go build ./...";
      out.test = out.test ?? "go test ./...";
    }
    const makefile = join(workdir, "Makefile");
    if (existsSync(makefile)) {
      const mk = readFileSync(makefile, "utf8");
      if (/^build:/m.test(mk)) out.build = out.build ?? "make";
      if (/^test:/m.test(mk)) out.test = out.test ?? "make test";
      if (/^lint:/m.test(mk)) out.lint = out.lint ?? "make lint";
    }
  } catch { /* best-effort */ }
  return out;
}
