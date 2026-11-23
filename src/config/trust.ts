/**
 * Project-directory trust (P1-config-trust).
 *
 * A `.scoderrc.json` (or `.scoder/permissions.local.json`) is just another
 * file inside a cloned repository. Before this module it was honored
 * immediately, which gives any repo two attacks against the machine that
 * opens it:
 *
 *   exfiltration — `baseUrl` points every LLM request (API key + full prompt
 *     + workspace context) at the attacker's server; `providers` does the
 *     same for custom providers; `shellEnvAllow` leaks env var NAMES into
 *     child processes;
 *   execution — `formatter` runs after every file edit, `buildCmd`/`verifyCmds`
 *     run at the completion gate, `mcpServers` spawns processes at startup,
 *     `permissions`/`permission` loosen the approval policy itself, and a
 *     committed `permissions.local.json` masquerades as "commands the user
 *     already approved".
 *
 * Policy: the FIRST time a directory is used, sensitive project-config fields
 * are dropped (global/user config is never filtered) and a warning explains
 * how to accept them. Accepting is one-time and out-of-band:
 *
 *   scoder trust [path]              # add to ~/.scoder/trust.json
 *   SCODER_TRUST_PROJECT=1           # one-shot escape hatch (CI, scripts)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Project rc keys that only take effect once the directory is trusted.
 * Everything else (model, theme, limits, …) is a preference, not a capability.
 */
export const PROJECT_RC_SENSITIVE_KEYS: readonly string[] = [
  "baseUrl",
  "apiKey",
  "providers",
  // P2.1: the opencode-style block carries endpoints AND inline keys — a
  // cloned repo must not exfiltrate SCODER_* keys to its own baseURL before
  // the user trusts it. (The legacy string selector is gated together with
  // it; the anthropic/claude- heuristics keep working either way.)
  "provider",
  "mcpServers",
  "buildCmd",
  "verifyCmds",
  "formatter",
  "permission",
  "permissions",
  "sandbox",
  "shellEnvAllow",
];

/** Where the accepted-directories list lives (overridable for tests). */
export function trustFilePath(): string {
  return process.env.SCODER_TRUST_FILE || join(homedir(), ".scoder", "trust.json");
}

function canonical(dir: string): string {
  const abs = resolve(dir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

// ---------------------------------------------------------------------------
// Trust store (~/.scoder/trust.json: { "trusted": ["/abs/path", …] })
// ---------------------------------------------------------------------------

/** stat-stamp memo (same invalidation contract as the rc reader in config.ts). */
const storeMemo = new Map<string, { m: number; s: number; roots: string[] }>();

function loadStore(): { trusted: string[] } {
  const p = trustFilePath();
  let st = { m: -1, s: -1 };
  try {
    const s = statSync(p);
    st = { m: s.mtimeMs, s: s.size };
  } catch {
    /* missing/unreadable → empty store */
  }
  const hit = storeMemo.get(p);
  if (hit && hit.m === st.m && hit.s === st.s) return { trusted: hit.roots };
  let roots: string[] = [];
  if (st.m >= 0) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
      const list = raw && typeof raw === "object" && Array.isArray((raw as { trusted?: unknown }).trusted)
        ? (raw as { trusted: unknown[] }).trusted
        : [];
      roots = list.filter((x): x is string => typeof x === "string" && x.length > 0);
    } catch {
      roots = [];
    }
  }
  storeMemo.set(p, { m: st.m, s: st.s, roots });
  return { trusted: roots };
}

function writeStore(roots: string[]): void {
  const p = trustFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ trusted: roots }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
  storeMemo.delete(p); // next read re-stats
}

/** Add a project directory to the trust store (idempotent). */
export function trustProject(dir: string): string {
  const c = canonical(dir);
  const roots = loadStore().trusted;
  if (!roots.includes(c)) writeStore([...roots, c]);
  for (const key of warnedOnce) if (key.startsWith(c + "|")) warnedOnce.delete(key);
  return c;
}

/** Remove a project directory from the trust store. Returns whether it was there. */
export function untrustProject(dir: string): boolean {
  const c = canonical(dir);
  const roots = loadStore().trusted;
  if (!roots.includes(c)) return false;
  writeStore(roots.filter((r) => r !== c));
  return true;
}

/** Every trusted root, canonicalized (for `scoder trust --list`). */
export function listTrustedProjects(): string[] {
  return loadStore().trusted;
}

/**
 * Does this workdir count as trusted? True when SCODER_TRUST_PROJECT=1 (CI
 * escape hatch), or when a trusted root IS the directory or one of its
 * ancestors (a trusted monorepo root covers its packages).
 */
export function isProjectTrusted(workdir: string): boolean {
  if (process.env.SCODER_TRUST_PROJECT === "1") return true;
  const dir = canonical(workdir);
  const roots = loadStore().trusted;
  return roots.some((r) => dir === r || dir.startsWith(r.endsWith(sep) ? r : r + sep));
}

// ---------------------------------------------------------------------------
// Application points
// ---------------------------------------------------------------------------

/** Directories we have already warned about (one warning per process). */
const warnedOnce = new Set<string>();

function warnOnce(workdir: string, what: string): void {
  const key = canonical(workdir) + "|" + what;
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.error(
    `⚠  Untrusted project directory: ${what} in ${workdir} was ignored.\n` +
      `   Trust this directory once: run \`scoder trust\` here, or set SCODER_TRUST_PROJECT=1.\n` +
      `   Trust store: ${trustFilePath()}\n`,
  );
}

/**
 * Filter a parsed PROJECT rc file for an untrusted directory. Returns a new
 * object with sensitive keys removed; trusted directories pass through.
 * Typed generically so config.ts keeps its RcFile shape.
 */
export function applyProjectTrust<T extends object>(rc: T, workdir: string): T {
  if (isProjectTrusted(workdir)) return rc;
  const view = rc as unknown as Record<string, unknown>;
  const dropped = PROJECT_RC_SENSITIVE_KEYS.filter((k) => view[k] !== undefined);
  if (dropped.length === 0) return rc;
  const clean: Record<string, unknown> = { ...view };
  for (const k of dropped) delete clean[k];
  warnOnce(workdir, `sensitive .scoderrc.json settings (${dropped.join(", ")})`);
  return clean as T;
}

/** Gate for <workdir>/.scoder/permissions.local.json (committed approvals). */
export function guardSavedApprovals(workdir: string): boolean {
  if (isProjectTrusted(workdir)) return true;
  // Only warn if the file actually exists — the common case is absence.
  if (existsSync(join(resolve(workdir), ".scoder", "permissions.local.json"))) {
    warnOnce(workdir, "saved permission approvals (.scoder/permissions.local.json)");
  }
  return false;
}
