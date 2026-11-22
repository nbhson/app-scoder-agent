/**
 * Catastrophic command detection (P0-3) — the hard floor no rule or mode can
 * override.
 *
 * The previous implementation was one flat list of ~30 regexes run against the
 * raw command string, and it failed in BOTH directions:
 *
 *   false DENY — `/rm\s+-rf\s+[/~"]/` matched any quoted or absolute target,
 *     so `rm -rf "node_modules"` and `rm -rf /tmp/build` were blocked with no
 *     way to override (the agent simply could not clean a build directory).
 *     The new floor is target-aware instead of character-aware: whole-home
 *     and top-level targets (`~`, `~/`, `~/*`, `$HOME`, `~/Documents`,
 *     `/Users/me`, `/`) stay fatal, while DEEPER paths (`~/proj/build`,
 *     `/tmp/build`, `/Users/me/proj/dist`) fall through to the permission
 *     rules (workspace allowlist / confirmation);
 *   false ALLOW — `rm -rf $HOME`, `rm -rf ${HOME}` (no literal `/` or `~` in
 *     the text), `curl https://x | zsh|dash|ksh|fish` (only sh/bash/python
 *     were named), `find / -delete`.
 *
 * Detection is now structural: the command line is split into pipeline /
 * sequence segments (quote-aware, no native dependency), each segment is
 * parsed into argv, and the rules ask real questions —
 *   "is this `rm` recursive AND does one operand name a critical root or a
 *    whole home directory?",
 *   "does a pipeline fetch remote content and hand it to an interpreter?",
 *   "does an interpreter's `-c` script itself contain a catastrophic command?".
 * A short regex list remains only for constructs argv analysis cannot see
 * (fork bombs, block-device redirects, `--no-preserve-root`, host tampering).
 */

import { homedir } from "node:os";
import { isAbsolute as posixIsAbsolute, normalize as posixNormalize, relative as posixRelative } from "node:path/posix";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Prefixes that only launch another command — skip them to reach argv[0]. */
const WRAPPERS = new Set(["sudo", "doas", "time", "nohup", "env", "command", "nice", "stdbuf"]);

/** Shells + interpreters: whatever is piped into them executes. */
const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "ash", "busybox",
  "python", "python2", "python3", "pypy", "pypy3", "perl", "ruby", "irb", "node", "nodejs",
  "deno", "bun", "php", "lua", "luajit", "tclsh", "wish", "expect", "awk", "gawk", "jshell",
  "pwsh", "powershell", "powershell.exe", "cmd", "cmd.exe",
]);

/** Interpreters that run an inline script from a flag (`sh -c`, `perl -e`). */
const INLINE_SCRIPT_FLAGS: Record<string, string[]> = {
  sh: ["-c", "-lc"], bash: ["-c", "-lc"], zsh: ["-c", "-lc"], dash: ["-c"], ksh: ["-c"],
  fish: ["-c"], csh: ["-c"], tcsh: ["-c"],
  python: ["-c"], python2: ["-c"], python3: ["-c"], pypy: ["-c"], pypy3: ["-c"],
  perl: ["-e", "-E"], ruby: ["-e"], node: ["-e", "--eval", "-p"], nodejs: ["-e", "--eval"],
  php: ["-r"], lua: ["-e"],
  pwsh: ["-c", "-command"], powershell: ["-c", "-command", "-enc", "-encodedcommand", "-e"],
};

/** Programs whose output is remote content. */
const FETCHERS = new Set(["curl", "wget", "fetch", "nc", "ncat", "netcat", "ftp", "telnet", "lynx", "aria2c", "gsutil"]);

/** Interpreter at the head of a pipeline — `sh <<'EOF'` executes the heredoc. */
const PIPE_HEAD_INTERPRETER = /^(?:[^\s|;&]*\/)?(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|python\d*|perl|ruby|node|nodejs|php|lua|pwsh|powershell(?:\.exe)?)(?=[\s;|&]|$)/i;

/** Recursive spelling for `rm` (`-r`, `-R`, `-rf`, `--recursive`, …). */
function isRecursive(argv: string[]): boolean {
  return argv.some((a) => a === "--recursive" || (/^-[a-zA-Z]+$/.test(a) && /[rR]/.test(a)));
}

/** Block devices — `dd of=` / `>` these wipes a disk. */
const BLOCK_DEVICE = /^\/dev\/(?:sd[a-z]+\d*|hd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|disk\d+|rdisk\d+|mmcblk\d+(?:p\d+)?|vd[a-z]+|xvd[a-z]+)$/;

// ---------------------------------------------------------------------------
// Segment splitting (quote-aware, dependency-free)
// ---------------------------------------------------------------------------

export interface Segment {
  /** argv tokens with quotes removed (empty when nothing but separators). */
  tokens: string[];
  /** Separator that PRECEDED this segment: "", "|", "&&", "||", ";", "\\n". */
  sepBefore: string;
  /** Raw segment text (regex fallbacks + messages). */
  raw: string;
}

/**
 * Split a command line into segments on unquoted `|`, `;`, `&&`, `||` and
 * newlines. `$( … )`, backticks and subshell parens are copied through whole,
 * so an inner separator never splits the line here — the inline-script rule
 * re-enters `isCatastrophic` on their contents instead.
 */
export function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let current = "";
  let pendingSep = "";
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    const raw = current.trim();
    if (raw) segments.push({ tokens: tokenize(raw), sepBefore: pendingSep, raw });
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      current += ch + (i + 1 < command.length ? command[++i] : "");
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      const end = matchParen(command, i + 1);
      current += command.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "(") {
      const end = matchParen(command, i);
      current += command.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      const stop = end === -1 ? command.length : end + 1;
      current += command.slice(i, stop);
      i = stop - 1;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      flush();
      pendingSep = two;
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      flush();
      pendingSep = ch;
      if (ch === "|" && (command[i + 1] === "&" || command[i + 1] === "|")) i++; // |& and || tails
      continue;
    }
    current += ch;
  }
  flush();
  return segments;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return s.length - 1;
}

/** Quote-aware argv split of one segment. */
export function tokenize(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < segment.length) cur += segment[++i];
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Critical target classification
// ---------------------------------------------------------------------------

/** Expansions that name the user's home directory. */
const HOME_FORMS = ["~", "$HOME", "${HOME}", "%HOME%", "$USERPROFILE", "${USERPROFILE}", "$env:HOME", "/root"];

/**
 * Does this operand name something CRITICAL — the filesystem root, a
 * top-level system directory, or somebody's entire home — as opposed to an
 * ordinary path inside a project? `rm -rf /tmp/build` is a build directory;
 * `rm -rf /tmp` is not.
 */
export function isCriticalTarget(raw: string): boolean {
  const t = (raw ?? "").trim().replace(/^["']+|["']+$/g, "");
  if (!t) return false;
  // Globs are noise when judging depth.
  const stripped = t.replace(/\/+\**$/, "");

  for (const h of HOME_FORMS) {
    if (stripped === h) return true;
    if (stripped.startsWith(h + "/") || stripped.startsWith(h + "\\")) {
      const rest = stripped.slice(h.length).replace(/^[/\\]+/, "").replace(/[/\\]+\**$/, "");
      if (rest === "" || rest === "*") return true; // ~, ~/, ~/*, $HOME, ${HOME}/*
      // One level below home is real user data (`~/Documents`, `~/.ssh`,
      // `~/Downloads`) — catastrophic territory. Deeper paths (`~/proj/build`)
      // are ordinary cleanups handled by the permission rules.
      if (!rest.includes("/") && !rest.includes("\\")) return true;
    }
  }

  const absolute = t.startsWith("/");
  const unc = t.startsWith("\\\\");
  if (!absolute && !unc) return false;

  const segs = stripped.split(/[/\\]+/).filter((s) => s.length > 0 && s !== "*");
  if (segs.length === 0) return true; // "/", "/*", "/**"
  // /Users and /home hold entire accounts. Their roots and every top-level
  // account directory are critical; DEEPER paths (`/Users/me/proj/build`)
  // are ordinary cleanups — the caller's workspace/temp checks decide those,
  // mirroring how `~/proj/…` sub-paths are handled above.
  if (segs[0] === "Users" || segs[0] === "home") {
    if (segs.length <= 3) return true; // /Users, /Users/me, /Users/me/Documents
    return false; // /Users/me/proj/build — a project path
  }
  if (segs.length === 1) return true; // /usr, /etc, /tmp, /dev, /opt …
  // /home/<user>, /Users/<user>, /Volumes/<share> — a whole account/mount.
  if (segs.length === 2 && ["home", "Users", "Volumes"].includes(segs[0])) return true;
  return false;
}

/** Does any non-flag operand of argv name a critical target? */
function touchesCriticalTarget(argv: string[]): boolean {
  for (const a of argv) {
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      if (eq > 0 && isCriticalTarget(a.slice(eq + 1))) return true;
      continue;
    }
    if (isCriticalTarget(a)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Constructs argv analysis cannot see
// ---------------------------------------------------------------------------

const CATASTROPHIC_PATTERNS: RegExp[] = [
  // Deliberate "apply it to the whole filesystem" opt-in.
  /\brm\s+[^|;&]*--no-preserve-root/i,
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  // Fork bomb.
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i,
  // Raw writes to block devices (`> /dev/sda`, `cat x > /dev/nvme0n1`).
  />\s*\/dev\/(?:sd[a-z]+|hd[a-z]+|nvme\d+n\d+(?:p\d+)?|disk\d|rdisk\d|mmcblk\d|vd[a-z]+|xvd[a-z]+)/i,
  // Reverse shells.
  /\|\s*nc\s+-e\s+/i,
  /\bbash\s+-i\b[^|;&]*>&[^|;&]*\/dev\/tcp\//i,
  // Kernel + sudoers tampering.
  /sysctl\s+-w\s+kernel\.panic=/i,
  /\b(?:echo|tee|cat)\b[^|;&]*>\s*\/etc\/sudoers/i,
  // Encoded PowerShell payload.
  /\bpowershell(?:\.exe)?\s+(?:-enc|-e\b|-encodedcommand\b)/i,
  // macOS host tampering.
  /\bdscl\s+\.\s+-create\s+\/Users\//i,
  /\bdefaults\s+write\s+com\.apple/i,
  // base64-decoded payload piped into a shell (the classic `echo <b64> |
  // base64 -d | sh` smuggle). Quoting hides this from argv analysis — the
  // payload may contain escaped quotes — so match the raw line; decoder flags
  // are specific enough to leave `base64 -d file.b64 > out.bin` alone.
  /\bbase64\s+(?:-[dD]|--decode)\b[^|;&]*\|\s*[\w./-]*(?:ba|z|da|k|c|tc|po|a|p)sh\b|\bbase64\s+(?:-[dD]|--decode)\b[^|;&]*\|\s*(?:python\d*|perl|ruby|node|php)\b/i,
  // Host power commands (a coding agent has no reason to run them).
  /(?:^|[;&|]\s*)(?:\/(?:sbin|usr\/sbin|bin)\/)?(?:shutdown|halt|poweroff|reboot)\b/i,
  /(?:^|[;&|]\s*)init\s+[06]\b/i,
];

// ---------------------------------------------------------------------------
// Per-segment argv rules
// ---------------------------------------------------------------------------

/** Skip launch wrappers (`sudo`, `time`, `env VAR=…`) to reach the real argv. */
function unwrap(tokens: string[]): { name: string; argv: string[] } {
  let i = 0;
  while (i < tokens.length) {
    const base = (tokens[i].split("/").pop() ?? "").toLowerCase();
    if (!WRAPPERS.has(base)) break;
    i++;
    // wrappers carry their own options and VAR=value assignments first
    while (i < tokens.length && (tokens[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
  }
  const rest = tokens.slice(i);
  const name = (rest[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
  return { name, argv: rest.slice(1) };
}

/** `rm -r` / `rm -rf` aimed at something critical (a whole home dir). */
function isCatastrophicRemove(name: string, argv: string[]): boolean {
  if (name !== "rm") return false;
  const clean = argv.map((a) => a.replace(/^["']+|["']+$/g, "")).filter(Boolean);
  return isRecursive(clean) && touchesCriticalTarget(clean);
}

/**
 * `rm` with recursive/force flags + an ABSOLUTE target. A path INSIDE the
 * workspace (or under /tmp) is ordinary cleanup — `rm -rf /Users/me/proj/dist`
 * must stay allowed; everything else absolute (/etc, /usr, /tmp/../usr style
 * escapes, another user's home) is fatal because the agent had no reason to
 * reach outside its own tree. Relative and `~` targets are left to the
 * permission rules.
 */
function isCatastrophicRemoveAbsolute(name: string, argv: string[], raw: string, _depth: number): boolean {
  if (name !== "rm") return false;
  const flags = argv.filter((a) => a.startsWith("-"));
  if (flags.length === 0) return false; // bare `rm file` is not mass destruction
  const recursive = flags.some((a) => a === "--recursive" || (/^-[a-zA-Z]+$/.test(a) && /[rR]/.test(a)));
  const force = flags.some((a) => a === "--force" || (/^-[a-zA-Z]+$/.test(a) && /f/.test(a)));
  if (!recursive && !force) return false;
  for (const a of argv) {
    if (a.startsWith("-")) continue;
    const t = a.replace(/^["']+|["']+$/g, "");
    if (!t.startsWith("/")) continue;
    if (isSafeAbsolutePath(t, raw)) continue;
    return true;
  }
  return false;
}

/** Absolute paths the agent may legitimately wipe: inside the workspace or tmp. */
function isSafeAbsolutePath(t: string, raw: string): boolean {
  const norm = posixNormalize(t);
  for (const base of ["/tmp", "/var/tmp", "/private/tmp"]) {
    if (norm === base) return false; // wiping ALL of tmp kills machine sockets
    if (norm.startsWith(base + "/")) return true;
  }
  for (const root of workspaceRoots(raw)) {
    const rel = posixRelative(root, norm);
    if (rel && !rel.startsWith("..") && !posixIsAbsolute(rel)) return true;
  }
  // The user's own home tree: agents routinely clean `~/proj/build`,
  // `~/.cache/foo`. Only WHOLE-HOME targets (`~`, `$HOME`) stay fatal — the
  // argv rules catch those via isCriticalTarget before this path check.
  let home = "";
  try {
    home = posixNormalize(homedir());
  } catch {
    /* no home */
  }
  if (home && home !== "/" && norm.startsWith(home + "/")) {
    const rest = posixRelative(home, norm).split("/")[0];
    // Dotfiles/state at the top of home stay fatal for system dirs users hide
    // there (real dot-directories exist — `.claude`, `.cache`); but never let
    // a bare home cleanup trip: only `~/.ssh`, `~/.gnupg` are that sensitive.
    if (rest === ".ssh" || rest === ".gnupg") return false;
    return true;
  }
  return false;
}

/**
 * Workspace roots available to the analyzer: process cwd (the agent runs
 * commands with cwd = workdir) plus $HOME's parent is NOT a root — a home
 * directory is never implicitly safe. `SCODER_WORKSPACE` overrides cwd.
 */
function workspaceRoots(_raw: string): string[] {
  const roots: string[] = [];
  const env = (typeof process !== "undefined" && process.env) || {};
  const push = (p?: string): void => {
    if (p && p.startsWith("/")) roots.push(posixNormalize(p.replace(/\/+$/, "")));
  };
  push(env.SCODER_WORKSPACE);
  try {
    push(process.cwd());
  } catch {
    /* cwd deleted */
  }
  return roots;
}

/** `chmod -R 777 /`, `chown -R nobody /etc` — recursive perms on a system tree. */
function isCatastrophicPerms(name: string, argv: string[]): boolean {
  if (!["chmod", "chown", "chgrp", "chflags"].includes(name)) return false;
  return isRecursive(argv) && touchesCriticalTarget(argv);
}

/** `find / -delete`, `find /usr -exec rm {} ;` — mass deletion under a root. */
function isCatastrophicFind(name: string, argv: string[]): boolean {
  if (name !== "find") return false;
  const destructive = argv.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(a));
  if (!destructive) return false;
  const starts: string[] = [];
  for (const a of argv) {
    if (a.startsWith("-")) break;
    starts.push(a);
  }
  return starts.some((s) => isCriticalTarget(s)) || argv.some((a) => !a.startsWith("-") && isCriticalTarget(a));
}

/** `mv ~ /tmp/void`, `mv /usr /tmp/x` — moving a whole tree away. */
function isCatastrophicMove(name: string, argv: string[]): boolean {
  if (name !== "mv") return false;
  const operands = argv.filter((a) => !a.startsWith("-"));
  return operands.length > 0 && isCriticalTarget(operands[0]);
}

/** `dd of=/dev/sda` — raw disk write. */
function isCatastrophicDd(name: string, argv: string[]): boolean {
  if (name !== "dd") return false;
  const out = argv.find((a) => a.startsWith("of="));
  if (!out) return false;
  const target = out.slice(3);
  return BLOCK_DEVICE.test(target) || isCriticalTarget(target);
}

/** Does this interpreter invocation carry an inline script flag (`-c`, `-e`)? */
function hasInlineScriptFlag(name: string, argv: string[]): boolean {
  const flags = INLINE_SCRIPT_FLAGS[name];
  if (!flags) return false;
  return argv.some((a) => flags.includes(a));
}

/**
 * `-c <script>` / `-e <script>` whose script text contains a destructive rm
 * (`rm -r…` + a root-ish operand). Quote-insensitive by design — it runs on
 * the raw word list, so payloads like `system( rm -rf / )` that defeat every
 * tokenizer still trip. Normal commands cannot produce both an inline flag and
 * `rm` + recursive flag + absolute operand in one segment by accident.
 */
function inlinePayloadContainsDestructive(text: string): boolean {
  for (const seg of splitSegments(text)) {
    const words = seg.raw.replace(/["']/g, " ").split(/[\s()]+/).filter(Boolean);
    for (let i = 0; i < words.length - 1; i++) {
      if (!/^-\w*[ce](?![a-z])/.test(words[i]) || words[i].startsWith("--")) continue;
      const tail = words.slice(i + 1);
      if (!tail.includes("rm")) continue;
      const recursive = tail.some((w) => /^-{1,2}[\w-]*[rR][\w-]*$/.test(w));
      const fatalOperand = tail.some((w) => w === "/" || w === "~" || w === "$HOME" || /^\*+$/.test(w) || /^\/usr|\/etc|\/bin|\/boot|\/sbin|\/var|\/home|\/root(\/|$)/.test(w));
      if (recursive && fatalOperand) return true;
    }
  }
  return false;
}

/**
 * Quoted string literals inside raw shell text (escape-aware, nesting kept
 * intact). `python3 -c "import os; os.system('rm -rf /')"` hides the payload
 * inside a string, and the argv tokenizer folds the whole call into one token
 * — so the literals of an inline script get analyzed as commands too.
 */
export function stringLiterals(text: string): string[] {
  const out: string[] = [];
  let quote: "'" | '"' | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!quote) {
      if (ch === "'" || ch === '"') {
        quote = ch;
        cur = "";
      }
      continue;
    }
    if (ch === "\\" && quote === '"') {
      cur += text[++i] ?? "";
      continue;
    }
    if (ch === quote) {
      if (cur.trim()) out.push(cur);
      quote = null;
      continue;
    }
    cur += ch;
  }
  return out;
}

/**
 * `sh -c "…"`, `python -c "…"`, `perl -e "…"` — run the embedded script
 * through the same rules instead of matching the wrapper text.
 */
function isCatastrophicInlineScript(name: string, argv: string[], raw: string, depth: number): boolean {
  if (!hasInlineScriptFlag(name, argv)) return false;
  // Analyze the RAW segment first: `… | python3 -c "…; rm -rf /…"` has `;`
  // inside the quoted payload, so the splitter cut the token list off before
  // the destructive word — the quote-blind view still sees it.
  if (hasInlineInterpretedCommand(raw)) return true;
  for (let i = 0; i < argv.length - 1; i++) {
    if ((INLINE_SCRIPT_FLAGS[name] ?? []).includes(argv[i]) && argv[i + 1] && isCatastrophicDepth(argv[i + 1], depth + 1)) {
      return true;
    }
  }
  // The payload may be a double-quoted string containing escaped inner
  // quotes (`python3 -c "…os.system(\'rm -rf /\')…"`): the tokenizer folds
  // the whole call into one token, so also analyze the raw segment text and
  // every quoted literal inside it. `splitSegments`/regexes are quote-blind,
  // which is exactly what reaches the smuggled command.
  return stringLiterals(raw).some((lit) => lit !== raw && isCatastrophicDepth(lit, depth + 1));
}

/** Find `-c <script>` / `-e <script>` payloads in a raw (possibly quote-
 * stripped) command line and re-analyze each as shell text. */
function hasInlineInterpretedCommand(raw: string, depth = 0): boolean {
  // Split on whitespace AND parens, and strip quote characters: `system(
  // "rm -rf /" )` has no space after `(`, and `perl -e '…'` would otherwise
  // isolate `'system` instead of `-e` — a quote-blind word list is the point.
  const words = raw.replace(/["']/g, " ").split(/[\s()]+/).filter(Boolean);
  for (let i = 0; i < words.length - 1; i++) {
    if (!/^-\w*[ce](?![a-z])/.test(words[i]) || words[i].startsWith("--")) continue;
    const payload = words.slice(i + 1).join(" ");
    // Depth-bounded recursion: the payload is itself shell text.
    if (payload && depth < MAX_SCRIPT_DEPTH && isCatastrophicDepth(payload, depth + 1)) return true;
  }
  return false;
}

/**
 * Pipeline shape: remote content feeding an interpreter. `curl https://x | zsh`
 * is exactly as fatal as `| sh`, and the old list only named a few shells.
 */
function isCatastrophicPipe(segments: Segment[], _depth: number): boolean {
  // A fatal pipe needs a real producer (fetcher / URL / non-interpreter
  // stage) feeding an interpreter sink. There is deliberately NO
  // "interpreter at the head is fatal" shortcut: at depth > 0 every inline
  // payload begins with some command (`sh -c 'node build.js'`), and the
  // producer rule below already catches `curl … | sh` inside script bodies.
  let producerSeen = false;
  for (const seg of segments) {
    const { name } = unwrap(seg.tokens);
    // Quote-aware interpreter test on the RAW segment text: a `;` inside the
    // payload truncates the tokenized view (`… | python3 -c "import x; …"`)
    // so tokens alone miss the shape.
    if (producerSeen && seg.sepBefore === "|" && PIPE_HEAD_INTERPRETER.test(seg.raw.trim())) return true;
    if (FETCHERS.has(name) || /https?:\/\/|ftp:\/\/|sftp:\/\/|ftps:\/\/|file:\/\/|data:/.test(seg.raw)) producerSeen = true;
    if (seg.sepBefore === "|" && name && !INTERPRETERS.has(name)) producerSeen = true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Do any segments contain a destructive command (rm/chmod/find/mv/dd/inline)? */
function hasDestructiveSegment(segments: Segment[], depth: number): boolean {
  for (const seg of segments) {
    if (seg.tokens.length === 0) continue;
    const { name, argv } = unwrap(seg.tokens);
    if (!name) continue;
    if (isCatastrophicRemove(name, argv)) return true;
    // Quoted operands (`rm -rf "~/x"`): the quote-blind re-tokenization below
    // strips them — re-normalize argv so EVERY rule receives clean operands,
    // not just rm's own.
    const cleanArgv = argv.map((a) => a.replace(/^["']+|["']+$/g, "")).filter(Boolean);
    if (
      isCatastrophicRemoveAbsolute(name, cleanArgv, seg.raw, depth) ||
      isCatastrophicPerms(name, cleanArgv) ||
      isCatastrophicFind(name, cleanArgv) ||
      isCatastrophicMove(name, cleanArgv) ||
      isCatastrophicDd(name, cleanArgv) ||
      isCatastrophicInlineScript(name, argv, seg.raw, depth)
    ) {
      return true;
    }
  }
  return false;
}

/** Hard floor for one shell command line. Cheap, pure, dependency-free. */
export function isCatastrophic(command: string): boolean {
  return isCatastrophicDepth(command, 0);
}

/** Nesting cap for the inline-script recursion (`sh -c "sh -c \"…\""`). */
const MAX_SCRIPT_DEPTH = 4;

function isCatastrophicDepth(command: string, depth: number): boolean {
  if (!command || !command.trim() || depth > MAX_SCRIPT_DEPTH) return false;
  // 1. String-level constructs argv analysis cannot see (fork bomb, mkfs,
  //    block devices, power commands, decoders feeding shells, …).
  if (CATASTROPHIC_PATTERNS.some((p) => p.test(command))) return true;

  // 2. Quote-blind view: `perl -e 'system("rm -rf /")'` and `rm -rf "~/x"`
  //    fold destructive text into single argv tokens; replacing quotes with
  //    spaces and re-running the same analysis reaches it. This covers both
  //    inline `-c/-e` payloads (`hasInlineInterpretedCommand`'s own word
  //    splitting is quote-blind) and plain targets with home/workspace
  //    exceptions.
  const blind = command.replace(/["']/g, " ");
  const hasQuotes = blind !== command;
  if (hasQuotes && isCatastrophicDepth(blind, MAX_SCRIPT_DEPTH)) return true;

  // 3. Structural argv rules on the real tokenization (depth is truthful, so
  //    recursion can go through here — `sh -c "bash -c '…'"`).
  const segments = splitSegments(command);
  if (hasDestructiveSegment(segments, depth)) return true;

  // 4. Interpreter-as-payload rules that need the RAW line: quote-folding in
  //    step 2 destroys the `-c <one-token-payload>` shape, so check it here
  //    with depth+1 (and via step 2's recursion for space-separated payloads).
  if (hasQuotes) {
    if (inlinePayloadContainsDestructive(command)) return true;
    if (hasInlineInterpretedCommand(command, depth)) return true;
  }
  return isCatastrophicPipe(segments, depth);
}

/** Human-readable reason for the first matching rule (UI + audit log). */
export function catastrophicReason(command: string): string | null {
  if (!isCatastrophic(command)) return null;
  for (const seg of splitSegments(command)) {
    const { name, argv } = unwrap(seg.tokens);
    if (!name) continue;
    if (isCatastrophicRemove(name, argv)) return "recursive rm targeting a filesystem root or home directory";
    if (isCatastrophicRemoveAbsolute(name, argv, seg.raw, 0)) return "recursive/force rm targeting an absolute path outside the workspace";
    if (isCatastrophicPerms(name, argv)) return `recursive ${name} targeting a filesystem root or home directory`;
    if (isCatastrophicFind(name, argv)) return "find with -delete/-exec under a filesystem root";
    if (isCatastrophicMove(name, argv)) return "moving a filesystem root or home directory";
    if (isCatastrophicDd(name, argv)) return "dd writing to a raw device or system path";
    if (hasInlineScriptFlag(name, argv)) return `${name} inline script contains a catastrophic command`;
  }
  if (isCatastrophicPipe(splitSegments(command), 0)) return "remote content piped into an interpreter";
  return "matches a catastrophic command pattern";
}
