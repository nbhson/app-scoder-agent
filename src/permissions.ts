/**
 * Permission & Safety System
 *
 * Layer giữa LLM tool call và actual execution.
 * Cung cấp 3 mode: auto (run everything), ask (prompt for shell commands), readonly.
 * Luôn deny catastrophic commands bất kể mode nào.
 */

import { createRequire } from "node:module";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Catastrophic command patterns — always denied, no exceptions
// ---------------------------------------------------------------------------

const CATASTROPHIC_PATTERNS: RegExp[] = [
  // rm -rf (original) — kept for backwards compatibility
  /rm\s+-rf\s+[/~"]|(?:rm\s+-rf\s+\/\*)/i,
  // rm with whitespace/flag variants: "rm  -rf /", "rm -fr /", "rm -r -f /",
  // "rm --recursive --force /", "rm -rvf /" … i.e. any rm followed by one or
  // more option flags and then a target at filesystem root or home.
  // Does NOT match common safe commands: "rm -rf node_modules", "rm file.txt",
  // "rm ./build" (target must START with / or ~).
  /\brm\s+(?:-{1,2}[\w-]+\s+)+["']?[/~](?:\s|$|\/)/,
  // rm with a single flag token containing both r/R and f (e.g. -fr, -Rf, -rvf)
  // targeting / or ~ — covered above, but also catch "rm -fr --no-preserve-root".
  /\brm\s+[^|;&>]*--no-preserve-root/i,
  // base64/sh -c wrappers used to smuggle destructive commands past filters:
  //   echo cm0gLXJmIC8= | base64 -d | sh
  //   sh -c "rm -rf /"
  /base64\s+(?:-d|-D|--decode)\b[^|;&]*\|\s*(?:ba|z|da)?sh\b/i,
  /\b(?:ba|z|da)?sh\s+-c\s+["'][^"']*\brm\s+[^"']*\s-[a-zA-Z]*[rf]/i,
  // Filesystem destruction
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  /dd\s+.*of=\//i,
  /chmod\s+-R\s+0[77][07][07]\s+[/~]/i,
  // chmod -R 777 on / or ~ (any flag spelling: -R, -r, -Rf, --recursive)
  /\bchmod\s+(?:-{1,2}[\w-]+\s+)+[0-7]{3,4}\s+["']?[/~](?:\s|$|\/)/,
  /\bchmod\s+--recursive\s+[0-7]{3,4}\s+\/(?!home\/)[^\n]*/,
  // Redirect raw writes to block devices: > /dev/sda, > /dev/nvme0n1, dd > disk...
  />\s*\/dev\/(?:sd[a-z]+|hd[a-z]+|nvme\d+n\d+(?:p\d+)?|disk\d|rdisk\d)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i,
  // curl/wget pipe-to-shell: match any content between command and '| sh'/'| bash'
  // Handles -qO-, -X POST, etc. flags; URL-like patterns must contain '/' or '.'
  /curl\s+.*[/.].*\s*\|\s*sh\b/i,
  /curl\s+.*[/.].*\s*\|\s*bash\b/i,
  /wget\s+.*[/.].*\s*\|\s*sh\b/i,
  /wget\s+.*[/.].*\s*\|\s*bash\b/i,
  // sudo rm with any recursive/force flag combo: "sudo rm -rf x", "sudo rm -fr /usr"
  /sudo\s+rm\s+[^|;&]*-\w*[rR]/i,
  /\bshutdown\b|\breboot\b|\binit\s+[06]\b/i,
  />\s*\/dev\/sda/i,
  /\|\s*nc\s+-e\s+/i,
  /\|\s*bash\s+-i/i,
  /sysctl\s+-w\s+kernel\.panic=/i,
  /echo\s+[^|]*>\s*\/etc\/sudoers/i,
  // H-13 additions: remote-code-exec variants + macOS host tampering
  /curl\s+.*[/.].*\s*\|\s*python(?:\d)?\b/i,
  /wget\s+.*[/.].*\s*\|\s*python(?:\d)?\b/i,
  /\bpowershell(?:\.exe)?\s+(-enc|-e\b|-encodedcommand\b)/i,
  /\bdscl\s+\.\s+-create\s+\/Users\//i,
  /\bdefaults\s+write\s+com\.apple/i,
  /\bmv\s+(-\w+\s+)*["']?~(?:\s|$|\/(?!Projects|work))/,
  /\bcurl\s+.*[/.].*\s*\|\s*python3?\s+-c\b/i,
  /\bperl\s+-e\b.*\bsystem\s*\(/i,
];

function isCatastrophic(command: string): boolean {
  return CATASTROPHIC_PATTERNS.some((p) => p.test(command));
}

// ---------------------------------------------------------------------------
// Rule-based Permission Engine v2
//
// Source: anomalyco/opencode (packages/core/src/permission.ts) — adapted from
// Effect-TS to plain TypeScript. Ordered rules, last match wins, wildcard
// resources (* and ?). No match => "ask" (safe default). Catastrophic regex
// deny always runs FIRST as a hard floor no rule can override.
// ---------------------------------------------------------------------------

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionRule {
  /** Action: "shell" | "edit" | "webfetch" | "skill" | "subagent" | "external_directory" | "mcp__<server>__<tool>" */
  action: string;
  /** Resource pattern: literal path/prefix or wildcard pattern with * and ? */
  resource: string;
  effect: PermissionEffect;
}

/** Wildcard match: supports * (any run) and ? (single char). */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*") && !pattern.includes("?")) {
    // Literal match — also accept prefix semantics for shell resources
    // ("npm " allows "npm run build") to stay compatible with legacy lists.
    return value === pattern || (pattern.endsWith(" ") ? value.startsWith(pattern) : value.startsWith(`${pattern} `));
  }
  const rx = new RegExp(
    "^" +
      pattern
        .split("")
        .map((c) =>
          c === "*" ? "[\\s\\S]*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
        )
        .join("") +
      "$",
  );
  return rx.test(value);
}

export function matchRule(rules: PermissionRule[], action: string, resource: string): PermissionEffect | null {
  let effect: PermissionEffect | null = null;
  for (const r of rules) {
    // Action match: exact, or a wildcard action pattern (e.g. "mcp__prompt-gate__*").
    if (r.action !== action && !wildcardMatch(r.action, action)) continue;
    if (!wildcardMatch(r.resource, resource)) continue;
    effect = r.effect; // last match wins
  }
  return effect;
}

/**
 * Aggregate a multi-resource operation (a shell command produces several
 * subcommand resources): deny wins over ask wins over allow; null when no
 * rule matched at all.
 */
export function aggregate(effects: Array<PermissionEffect | null>): PermissionEffect | null {
  if (effects.length === 0) return null;
  let sawAsk = false;
  let sawAllow = false;
  for (const e of effects) {
    if (e === "deny") return "deny";
    if (e === "ask") sawAsk = true;
    if (e === "allow") sawAllow = true;
  }
  if (sawAsk) return "ask";
  if (sawAllow) return "allow";
  return null;
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
/**
 * G2: classifyCommand đã bị xoá — dùng `PermissionChecker.classify()`.
 * Giữ lại chỉ vì test cũ; body chuyển hướng sang checker thuần (không
 * config lists — G2 lists là builtin rules trong checker).
 */
export function classifyCommand(
  command: string,
  mode: PermissionMode,
  configAllow: string[],
  configDeny: string[],
  sessionAllow: SessionAllowlist,
): PermissionResult {
  // Reconstruct semantics qua rule engine: lists → builtin rules.
  const checker = new PermissionChecker({
    mode,
    allowCommands: configAllow,
    denyCommands: configDeny,
    nonInteractive: true,
  });
  if (sessionAllow.hasMatch(command)) return { decision: "allow", reason: "allowed by session allowlist" };
  return checker.classify(command);
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

/** T-03: answer set for programmatic permission prompts (TUI modal). */
export type PermissionAnswer = "yes" | "always" | "no" | "quit";

/** T-03: request payload handed to a promptHandler (or rendered by readline). */
export interface PermissionRequest {
  kind: "shell" | "edit" | "mcp";
  /** Human label — command line, file path, or MCP tool name. */
  label: string;
  /** Full command (shell kind). */
  command?: string;
  /** Unified diff preview (edit kind, truncated). */
  diff?: string;
  /** Prefix for "always" (shell kind — session allowlist). */
  alwaysAllowPrefix?: string;
  timeoutSecs: number;
}

export interface PermissionConfig {
  mode: PermissionMode;
  allowCommands: string[];
  denyCommands: string[];
  /** Whether to skip confirmation in non-interactive mode (for CI) */
  nonInteractive: boolean;
  /** Rule-based engine v2 (optional — legacy lists still work alongside). */
  rules?: PermissionRule[];
  /** Saved "always allow" rules persisted across sessions (project-scoped). */
  savedRules?: PermissionRule[];
  /** Policy hard floor — its deny always wins, allow bypasses ask. */
  policyRules?: PermissionRule[];
}

/**
 * G2: legacy allow/deny prefix lists → builtin rules (last-match-wins:
 * deny list đặt sau allow list để deny luôn thắng khi cả hai khớp).
 * Được append SAU user rules trong activeRules() — giữ nguyên ngữ nghĩa cũ
 * (config lists override rules cho prefix trùng).
 */
function builtinRulesFromLists(allow: string[], deny: string[]): PermissionRule[] {
  const toRules = (list: string[], effect: PermissionEffect): PermissionRule[] =>
    list.filter((p) => p.trim().length > 0).map((p) => ({ action: "shell", resource: p.trim(), effect }));
  return [...toRules(allow, "allow"), ...toRules(deny, "deny")];
}

export class PermissionChecker {
  private sessionAllow = new SessionAllowlist();
  private allowAllEdits = false;

  /**
   * T-03: programmatic prompt hook (TUI). When set, confirm/confirmEdit/
   * confirmAsk route through it instead of readline stdin (which corrupts
   * alt-screen). Returns a Promise resolved by the frontend modal.
   */
  promptHandler: ((req: PermissionRequest) => Promise<PermissionAnswer>) | null = null;

  constructor(
    private config: PermissionConfig,
  ) {}

  /** Dispatch to promptHandler with timeout ⇒ deny (safe default). */
  private async ask(req: PermissionRequest): Promise<boolean> {
    if (!this.promptHandler) return false; // no handler in alt-screen = deny
    try {
      // T3: timeout enforced HERE (checker-level) — a hung frontend handler
      // (TUI modal never answered, server client disconnected) must not leak
      // the pending permission promise forever.
      const answer = await Promise.race([
        this.promptHandler(req),
        new Promise<never>((_, rej) =>
          setTimeout(() => {
            const e = new Error("permission handler timed out");
            e.name = "AbortError";
            rej(e);
          }, req.timeoutSecs * 1000),
        ),
      ]);
      if (answer === "quit") this.abortRequested = true;
      if (answer === "always" && req.kind === "edit") this.allowAllEdits = true;
      if (answer === "always" && req.kind === "shell" && req.alwaysAllowPrefix) {
        this.sessionAllow.addPrefix(req.alwaysAllowPrefix);
      }
      return answer === "yes" || answer === "always";
    } catch {
      return false; // handler error/timeout — deny
    }
  }

  /** Rules for one evaluation: config rules + saved rules (config wins on deny). */
  private activeRules(): PermissionRule[] {
    // G2: legacy allow/deny lists trở thành builtin rules (priority thấp
    // nhất — user/saved rules override). Deny list sau allow list trong
    // builtin để deny thắng khi cả hai khớp (last-match-wins).
    return [
      ...builtinRulesFromLists(this.config.allowCommands, this.config.denyCommands),
      ...(this.config.savedRules ?? []),
      ...(this.config.rules ?? []),
    ];
  }

  /**
   * Policy hard-floor check: policy deny wins over everything except the
   * catastrophic list; policy allow bypasses ask-requirements.
   */
  private policyEffect(action: string, resource: string): PermissionEffect | null {
    if (!this.config.policyRules || this.config.policyRules.length === 0) return null;
    return matchRule(this.config.policyRules, action, resource);
  }

  /**
   * Rule-engine classify for a (action, resource) pair.
   * Order: config/saved rules (last match wins) → mode fallback.
   * Returns null when nothing matched (caller decides via mode).
   */
  classifyAction(action: string, resource: string): { decision: CommandDecision; reason: string } | null {
    const effect = matchRule(this.activeRules(), action, resource);
    if (effect === "deny") return { decision: "deny", reason: `denied by permission rule (${action}: ${resource})` };
    if (effect === "allow") return { decision: "allow", reason: `allowed by permission rule (${action}: ${resource})` };
    if (effect === "ask") return { decision: "ask", reason: `requires approval by permission rule (${action}: ${resource})` };
    return null;
  }

  /**
   * G5: unified MCP tool decision — policy floor → rules → null (caller
   * falls back to mode). Every mcp__* call goes through here; no bypass.
   *
   * Phase 5: `trust` (per-server configured trust for MCP tools) is layered
   * on top — it is the strictest check except for policy hard floors:
   *   - "deny"     → always deny (explicit user intent, beats rules/ask)
   *   - "ask"      → force a confirmation even when mode would auto-allow
   *   - "readonly" → deny execution (tools aren't spawned, defense in depth)
   *   - "auto"|undefined → no override (existing policy/rules/mode fallback)
   */
  classifyMcpTool(
    fullName: string,
    trust?: "auto" | "ask" | "readonly" | "deny",
  ): { decision: CommandDecision; reason: string } | null {
    const policy = this.policyEffect(fullName, "*");
    if (policy === "deny") return { decision: "deny", reason: "denied by policy (hard floor)" };
    // Per-server trust: deny beats allow-rules (user intent trumps automation).
    if (trust === "deny") return { decision: "deny", reason: "server trust: deny" };
    if (trust === "readonly") return { decision: "deny", reason: "server trust: readonly — tools not spawned" };
    // Policy allow still bypasses trust:ask (enterprise hard floor wins).
    if (policy === "allow") return { decision: "allow", reason: "allowed by policy" };
    if (trust === "ask") return { decision: "ask", reason: "requires approval by server trust (ask)" };
    return this.classifyAction(fullName, "*");
  }

  /** Shell decision: policy floor → rules → legacy lists/mode. */
  classify(command: string): PermissionResult {
    // Catastrophic deny is the absolute floor.
    if (isCatastrophic(command)) {
      return { decision: "deny", reason: "matches catastrophic command pattern" };
    }
    // Policy deny wins over everything (enterprise hard floor).
    const policy = this.policyEffect("shell", command);
    if (policy === "deny") return { decision: "deny", reason: "denied by policy (hard floor)" };
    if (policy === "allow") {
      const deny = matchRule(this.activeRules(), "shell", command);
      if (deny === "deny") return { decision: "deny", reason: "denied by permission rule" };
      return { decision: "allow", reason: "allowed by policy" };
    }
    if (policy === "ask") {
      const deny = matchRule(this.activeRules(), "shell", command);
      if (deny === "deny") return { decision: "deny", reason: "denied by permission rule" };
      const allow = matchRule(this.activeRules(), "shell", command);
      if (allow === "allow") return { decision: "allow", reason: "allowed by permission rule" };
      return { decision: "ask", reason: "requires approval by policy", alwaysAllowPrefix: extractFirstWord(command) + " " };
    }
    // G2: một đường duy nhất — rules (bao gồm builtin từ allow/deny lists,
    // last-match-wins) → mode fallback. Session allowlist map thành rule allow.
    if (this.sessionAllow.hasMatch(command)) {
      return { decision: "allow", reason: "allowed by session allowlist" };
    }
    const ruleEffect = matchRule(this.activeRules(), "shell", command);
    if (ruleEffect === "allow") return { decision: "allow", reason: "allowed by permission rule" };
    if (ruleEffect === "deny") return { decision: "deny", reason: "denied by permission rule" };
    if (ruleEffect === "ask") {
      return { decision: "ask", reason: "requires approval by permission rule", alwaysAllowPrefix: extractFirstWord(command) + " " };
    }
    switch (this.config.mode) {
      case "auto":
        return { decision: "allow", reason: "auto mode — run without confirmation" };
      case "readonly":
        return { decision: "deny", reason: "readonly mode — shell commands are disabled" };
      case "ask":
        return { decision: "ask", reason: "requires user confirmation", alwaysAllowPrefix: extractFirstWord(command) + " " };
    }
  }

  /**
   * Shell decision with AST scanner (pattern from opencode: every extracted
   * subcommand is checked individually; scanner errors ⇒ ask, never execute
   * unverified). Falls back to whole-line rules when the scanner is
   * unavailable (e.g. native module failed to load).
   */
  classifyShell(command: string): PermissionResult {
    // Catastrophic deny is the absolute floor — before scanner/splitting.
    if (isCatastrophic(command)) {
      return { decision: "deny", reason: "matches catastrophic command pattern" };
    }
    let scan: import("./shell-scanner.js").ShellScan | null;
    try {
      // Lazy require so a broken native build degrades instead of crashing.
      // (ESM dist — plain `require` is undefined; use createRequire.)
      const req = createRequire(import.meta.url);
      const { scanCommand } = req("./shell-scanner.js") as typeof import("./shell-scanner.js");
      scan = scanCommand(command);
    } catch {
      scan = null; // scanner unavailable — fall back to whole-line behavior
    }

    if (scan && !scan.ok) {
      return {
        decision: "ask",
        reason: `shell scanner: ${scan.error}`,
        alwaysAllowPrefix: extractFirstWord(command) + " ",
      };
    }

    if (scan && scan.ok && scan.commandLines.length > 1) {
      // Compound command — aggregate per-subcommand rule effects.
      const effects = scan.commandLines.map((l) => {
        const e = matchRule(this.activeRules(), "shell", l);
        if (e) return e;
        // No rule for this subcommand → fall back to whole-line decision chain
        // to keep legacy behavior (allowCommands/denyCommands prefixes).
        return this.classify(l).decision;
      });
      const agg = aggregate(effects);
      if (agg) {
        return {
          decision: agg,
          reason: `compound command (${scan.commandLines.length} subcommands) — aggregated: ${agg}`,
          alwaysAllowPrefix: agg === "ask" ? extractFirstWord(command) + " " : undefined,
        };
      }
    }

    // Dynamic eval without a rule → ask (never execute unverified dynamic code).
    if (scan?.ok && scan.hasDynamicEval) {
      const e = matchRule(this.activeRules(), "shell", command);
      if (e !== "allow") {
        return {
          decision: "ask",
          reason: "dynamic evaluation (eval/source) — approval required",
          alwaysAllowPrefix: extractFirstWord(command) + " ",
        };
      }
    }

    return this.classify(command);
  }

  /**
   * Ask user interactively. Returns true = allowed, false = denied.
   * In non-interactive mode, always returns false for "ask" decisions.
   */
  async confirm(command: string): Promise<boolean> {
    const result = this.classifyShell(command);

    if (result.decision === "allow") return true;
    if (result.decision === "deny") return false;

    // Decision is "ask"
    if (this.config.nonInteractive) {
      // In non-interactive (CI), deny commands that need asking
      return false;
    }

    // T-03: programmatic handler (TUI) — no stdin readline.
    if (this.promptHandler) {
      return this.ask({
        kind: "shell",
        label: command.length > 80 ? command.slice(0, 80) + "..." : command,
        command,
        alwaysAllowPrefix: result.alwaysAllowPrefix,
        timeoutSecs: 60,
      });
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
    // Rule engine for edit action (deny wins, ask prompts, allow skips).
    const ruleDecision = this.classifyAction("edit", path);
    if (ruleDecision?.decision === "deny") return false;
    if (ruleDecision?.decision === "allow") return true;
    // Policy floor for edit.
    const policy = this.policyEffect("edit", path);
    if (policy === "deny") return false;
    if (policy === "allow") return true;
    if (this.config.nonInteractive) {
      return false;
    }

    // T-03: programmatic handler (TUI) — modal shows the diff.
    if (this.promptHandler) {
      return this.ask({
        kind: "edit",
        label: path,
        diff: diffText.length > 4000 ? diffText.slice(0, 4000) + "\n… (truncated)" : diffText,
        timeoutSecs,
      });
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

  /** Ask user to approve an MCP tool call; "always" persists via onAlways callback. */
  async confirmMcpTool(fullName: string, onAlwaysAllow?: () => void): Promise<boolean> {
    return this.confirmAsk(`MCP tool ${fullName}`, onAlwaysAllow);
  }

  /**
   * Generic interactive ask (used for MCP tool approval etc.). Reuses the
   * same readline prompt as shell confirm. onAlways is invoked when the
   * user answers "a" (persist a saved approval).
   */
  async confirmAsk(label: string, onAlways?: () => void): Promise<boolean> {
    if (this.config.nonInteractive) return false;
    // T-03: programmatic handler (TUI).
    if (this.promptHandler) {
      const ok = await this.ask({ kind: "mcp", label, timeoutSecs: 60 });
      if (ok && onAlways) onAlways();
      return ok;
    }
    return promptForPermission(
      { command: label, alwaysAllowPrefix: undefined },
      // promptForPermission passes a prefix; we only need the "a" signal.
      () => onAlways?.(),
    );
  }

  /** Set when the user pressed [q]uit in confirmEdit — the agent should stop. */
  public abortRequested = false;
}
