/**
 * Permission & Safety System
 *
 * Layer giữa LLM tool call và actual execution.
 * Cung cấp 3 mode: auto (run everything), ask (prompt for shell commands), readonly.
 * Luôn deny catastrophic commands bất kể mode nào.
 */

import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Catastrophic command patterns — always denied, no exceptions
// ---------------------------------------------------------------------------

const CATASTROPHIC_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+[/~"]|(?:rm\s+-rf\s+\/\*)/i,
  /mkfs\b/i,
  /dd\s+.*of=\//i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i,
  // curl/wget pipe-to-shell: match any content between command and '| sh'/'| bash'
  // Handles -qO-, -X POST, etc. flags; URL-like patterns must contain '/' or '.'
  /curl\s+.*[/.].*\s*\|\s*sh\b/i,
  /curl\s+.*[/.].*\s*\|\s*bash\b/i,
  /wget\s+.*[/.].*\s*\|\s*sh\b/i,
  /wget\s+.*[/.].*\s*\|\s*bash\b/i,
  /sudo\s+rm\s+-rf/i,
  /\bshutdown\b|\breboot\b|\binit\s+[06]\b/i,
  /chmod\s+-R\s+0[77][07][07]\s+[/~]/i,
  />\s*\/dev\/sda/i,
  /\|\s*nc\s+-e\s+/i,
  /\|\s*bash\s+-i/i,
  /sysctl\s+-w\s+kernel\.panic=/i,
  /echo\s+[^|]*>\s*\/etc\/sudoers/i,
];

function isCatastrophic(command: string): boolean {
  return CATASTROPHIC_PATTERNS.some((p) => p.test(command));
}

// ---------------------------------------------------------------------------
// Permission mode
// ---------------------------------------------------------------------------

export type PermissionMode = "auto" | "ask" | "readonly";

export function isDangerousCommand(command: string): boolean {
  return isCatastrophic(command);
}

// ---------------------------------------------------------------------------
// Session allowlist (runtime, in-memory)
// ---------------------------------------------------------------------------

export class SessionAllowlist {
  private prefixes = new Set<string>();

  addPrefix(prefix: string): void {
    // Normalize to a word-bounded prefix: "git" -> "git " so that allowing
    // "git" never matches a different binary like "gitx" or "github-cli".
    const t = prefix.trim().replace(/\s+$/, "");
    if (t.length === 0) return;
    this.prefixes.add(`${t} `);
  }

  hasMatch(command: string): boolean {
    return [...this.prefixes].some((p) => command.startsWith(p));
  }

  clear(): void {
    this.prefixes.clear();
  }
}

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

export type CommandDecision = "allow" | "deny" | "ask";

export interface PermissionResult {
  decision: CommandDecision;
  reason: string;
  /** If ask, the safe prefix the user can "always allow" */
  alwaysAllowPrefix?: string;
}

function extractFirstWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

/**
 * Classify a command given current permission config and session allowlist.
 */
export function classifyCommand(
  command: string,
  mode: PermissionMode,
  configAllow: string[],
  configDeny: string[],
  sessionAllow: SessionAllowlist,
): PermissionResult {
  const safeFirst = extractFirstWord(command);

  // 1. Catastrophic — always deny
  if (isCatastrophic(command)) {
    return { decision: "deny", reason: "matches catastrophic command pattern" };
  }

  // 2. Config deny list
  if (configDeny.some((p) => command.startsWith(p.trim()))) {
    return { decision: "deny", reason: "matches denyCommands pattern in config" };
  }

  // 3. Session allowlist
  if (sessionAllow.hasMatch(command)) {
    return { decision: "allow", reason: "allowed by session allowlist" };
  }

  // 4. Config allow list
  if (configAllow.some((p) => command.startsWith(p.trim()))) {
    return { decision: "allow", reason: "allowed by config allowCommands" };
  }

  // 5. Mode-dependent
  switch (mode) {
    case "auto":
      return { decision: "allow", reason: "auto mode — run without confirmation" };
    case "readonly":
      return {
        decision: "deny",
        reason: "readonly mode — shell commands are disabled",
      };
    case "ask":
      return {
        decision: "ask",
        reason: "requires user confirmation",
        alwaysAllowPrefix: safeFirst + " ",
      };
  }
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

export interface PromptOptions {
  command: string;
  alwaysAllowPrefix?: string;
  timeoutSecs?: number;
}

/**
 * Prompt user for permission. Returns true/false. "always" is signaled via
 * the alwaysAllowPrefix callback.
 * Uses AbortController so timeoutSecs is actually enforced (deny on timeout).
 */
export async function promptForPermission(
  opts: PromptOptions,
  onAlwaysAllow?: (prefix: string) => void,
): Promise<boolean> {
  const cmd = opts.command.length > 80 ? opts.command.slice(0, 80) + "..." : opts.command;
  const timeoutMs = (opts.timeoutSecs ?? 60) * 1000;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const rl = createInterface({ input: process.stdin, output: process.stdout, signal: ac.signal });
  // NOTE: Node's rl.question() callback is NOT invoked (and the promise never
  // settles) when the interface is closed by an aborted signal — so we must
  // race it against an abort promise or promptForPermission would hang forever.
  const question = (q: string): Promise<string> =>
    new Promise((res, _rej) => {
      rl.question(q, (ans) => res(ans));
    });
  let rejectAborted: ((e: Error) => void) | null = null;
  const aborted = new Promise<never>((_res, rej) => {
    rejectAborted = rej;
  });
  ac.signal.addEventListener(
    "abort",
    () => {
      const e = new Error("permission prompt timed out");
      e.name = "AbortError";
      rejectAborted?.(e);
    },
    { once: true },
  );


  try {
    let answer = "";
    while (true) {
      const timeoutStr = Math.ceil((opts.timeoutSecs ?? 60)) + "s";

      let prompt = `⚠  run_command requires approval: ${cmd} (timeout in ${timeoutStr})\n`;
      if (opts.alwaysAllowPrefix) {
        prompt += `[y] yes  [a] always allow "${opts.alwaysAllowPrefix}"  [n] no  [q] quit: `;
      } else {
        prompt += `[y] yes  [n] no  [q] quit: `;
      }

      try {
        answer = (await Promise.race([question(prompt), aborted])).trim().toLowerCase();
      } catch {
        // Timeout — AbortController triggered
        clearTimeout(timer);
        rl.close();
        return false; // safe default: deny on timeout
      }

      if (answer === "q") {
        clearTimeout(timer);
        rl.close();
        return false; // caller will abort
      }
      if (answer === "y") {
        clearTimeout(timer);
        rl.close();
        return true;
      }
      if (answer === "n") {
        clearTimeout(timer);
        rl.close();
        return false;
      }
      if (answer === "a" && opts.alwaysAllowPrefix) {
        clearTimeout(timer);
        rl.close();
        onAlwaysAllow?.(opts.alwaysAllowPrefix);
        return true;
      }
      // invalid answer — loop again (timeout still ticking)
    }
  } finally {
    clearTimeout(timer);
    try { rl.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Permission Checker — wired into Agent
// ---------------------------------------------------------------------------

export interface PermissionConfig {
  mode: PermissionMode;
  allowCommands: string[];
  denyCommands: string[];
  /** Whether to skip confirmation in non-interactive mode (for CI) */
  nonInteractive: boolean;
}

export class PermissionChecker {
  private sessionAllow = new SessionAllowlist();
  private allowAllEdits = false;

  constructor(
    private config: PermissionConfig,
  ) {}

  /**
   * Check if a command should run. Returns null = allowed immediately,
   * or a PermissionResult if user needs to be consulted.
   */
  classify(command: string): PermissionResult {
    return classifyCommand(
      command,
      this.config.mode,
      this.config.allowCommands,
      this.config.denyCommands,
      this.sessionAllow,
    );
  }

  /**
   * Ask user interactively. Returns true = allowed, false = denied.
   * In non-interactive mode, always returns false for "ask" decisions.
   */
  async confirm(command: string): Promise<boolean> {
    const result = this.classify(command);

    if (result.decision === "allow") return true;
    if (result.decision === "deny") return false;

    // Decision is "ask"
    if (this.config.nonInteractive) {
      // In non-interactive (CI), deny commands that need asking
      return false;
    }

    return promptForPermission(
      {
        command,
        alwaysAllowPrefix: result.alwaysAllowPrefix,
      },
      (prefix) => this.sessionAllow.addPrefix(prefix),
    );
  }

  get sessionAllowlist(): SessionAllowlist {
    return this.sessionAllow;
  }

  /**
   * Ask user to approve a file write/edit, showing the diff first.
   * Returns true = approved, false = rejected.
   * Enforced timeout (default 120s) — deny on timeout (safe default).
   */
  async confirmEdit(path: string, diffText: string, timeoutSecs = 120): Promise<boolean> {
    if (this.allowAllEdits) return true;
    if (this.config.nonInteractive) {
      return false;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutSecs * 1000);
    const rl = createInterface({ input: process.stdin, output: process.stdout, signal: ac.signal });
    const question = (q: string): Promise<string> =>
      new Promise((res) => rl.question(q, (ans) => res(ans)));
    let rejectAborted: ((e: Error) => void) | null = null;
    const aborted = new Promise<never>((_res, rej) => {
      rejectAborted = rej;
    });
    ac.signal.addEventListener("abort", () => {
      const e = new Error("edit confirmation timed out");
      e.name = "AbortError";
      rejectAborted?.(e);
    }, { once: true });

    try {
      for (;;) {
        let answer: string;
        try {
          answer = (
            await Promise.race([
              question(`\nApply this change to ${path}? [y]es  [a] always (this session)  [n]o  [q]uit: `),
              aborted,
            ])
          ).trim().toLowerCase();
        } catch {
          // timeout — deny (safe default)
          return false;
        }

        if (answer === "y") return true;
        if (answer === "a") { this.allowAllEdits = true; return true; }
        if (answer === "n") return false;
        if (answer === "q") {
          // Graceful abort signal instead of process.exit from library code
          this.abortRequested = true;
          return false;
        }
        // invalid answer — loop again (timeout still ticking)
      }
    } finally {
      clearTimeout(timer);
      try { rl.close(); } catch { /* already closed */ }
    }
  }

  /** Set when the user pressed [q]uit in confirmEdit — the agent should stop. */
  public abortRequested = false;
}
