/**
 * Permission & Safety System
 *
 * Layer giữa LLM tool call và actual execution.
 * Cung cấp 3 mode: auto (run everything), ask (prompt for shell commands), readonly.
 * Luôn deny catastrophic commands bất kể mode nào.
 */

import { createInterface } from "node:readline";
import type { AgentConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Catastrophic command patterns — always denied, no exceptions
// ---------------------------------------------------------------------------

const CATASTROPHIC_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+[\/~"]|(?:rm\s+-rf\s+\/\*)/i,
  /mkfs\b/i,
  /dd\s+.*of=\//i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i,
  /curl\s+[^\s]*\|\s*sh/i,
  /wget\s+[^\s]*\|\s*sh/i,
  /sudo\s+rm\s+-rf/i,
  /\bshutdown\b|\breboot\b|\binit\s+[06]\b/i,
  /chmod\s+-R\s+0[77][07][07]\s+[\/~]/i,
  /\>\s*\/dev\/sda/i,
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
    // Normalize: strip trailing spaces/newlines
    this.prefixes.add(prefix.trim().replace(/\s+$/, ""));
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
 */
export async function promptForPermission(
  opts: PromptOptions,
  onAlwaysAllow?: (prefix: string) => void,
): Promise<boolean> {
  const cmd = opts.command.length > 80 ? opts.command.slice(0, 80) + "..." : opts.command;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, (ans) => res(ans)));

  let answer = "";
  const timeoutMs = (opts.timeoutSecs ?? 60) * 1000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remaining = Math.max(0, deadline - Date.now()) / 1000;
    const timeoutStr = remaining > 1 ? `${Math.ceil(remaining)}s` : "";

    let prompt = `\n⚠  run_command requires approval: ${cmd}${timeoutStr ? ` (timeout in ${timeoutStr})` : ""}\n`;
    if (opts.alwaysAllowPrefix) {
      prompt += `[y] yes  [a] always allow "${opts.alwaysAllowPrefix}"  [n] no  [q] quit: `;
    } else {
      prompt += `[y] yes  [n] no  [q] quit: `;
    }

    answer = (await question(prompt)).trim().toLowerCase();
    if (answer === "q") {
      rl.close();
      return false; // caller will abort
    }
    if (answer === "y") {
      rl.close();
      return true;
    }
    if (answer === "n") {
      rl.close();
      return false;
    }
    if (answer === "a" && opts.alwaysAllowPrefix) {
      rl.close();
      onAlwaysAllow?.(opts.alwaysAllowPrefix);
      return true;
    }
    // invalid answer — loop
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
   */
  async confirmEdit(path: string, diffText: string): Promise<boolean> {
    if (this.allowAllEdits) return true;
    if (this.config.nonInteractive) {
      return false;
    }

    // Show the diff (caller passes colored rendering via ui.printDiff upstream;
    // here we print raw — the tool layer calls ui.printDiff before prompting)
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const question = (q: string): Promise<string> =>
      new Promise((res) => rl.question(q, (ans) => res(ans)));

    let approved = false;
    for (;;) {
      const answer = (
        await question(`\nApply this change to ${path}? [y]es  [a] always (this session)  [n]o  [q]uit: `)
      ).trim().toLowerCase();

      if (answer === "y") { approved = true; break; }
      if (answer === "a") { this.allowAllEdits = true; approved = true; break; }
      if (answer === "n") { approved = false; break; }
      if (answer === "q") { process.exit(130); }
    }
    rl.close();
    return approved;
  }
}
