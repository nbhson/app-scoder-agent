import process from "node:process";

// Honor NO_COLOR and non-TTY output: drop ANSI codes so logs/CI stay clean.
const COLOR = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

const RESET = COLOR ? "\x1b[0m" : "";
const BOLD = COLOR ? "\x1b[1m" : "";
const DIM = COLOR ? "\x1b[2m" : "";
const GREEN = COLOR ? "\x1b[32m" : "";
const YELLOW = COLOR ? "\x1b[33m" : "";
const RED = COLOR ? "\x1b[31m" : "";
const CYAN = COLOR ? "\x1b[36m" : "";
const BLUE = COLOR ? "\x1b[34m" : "";

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export function info(msg: string): void {
  console.log(`${DIM}[${ts()}]${RESET} ${msg}`);
}

export function step(stepNum: number, total: number, msg: string): void {
  console.log(`${BLUE}[${String(stepNum).padStart(2)}/${total}]${RESET} ${BOLD}▸ ${msg}${RESET}`);
}

export function success(msg: string): void {
  console.log(`${GREEN}✓${RESET} ${GREEN}${msg}${RESET}`);
}

export function warn(msg: string): void {
  console.log(`${YELLOW}⚠${RESET} ${YELLOW}${msg}${RESET}`);
}

export function error(msg: string): void {
  console.error(`${RED}✗${RESET} ${RED}${msg}${RESET}`);
}

export function llm(prefix: string, content: string): void {
  console.log(`${CYAN}${prefix}:${RESET} ${content.slice(0, 300)}${content.length > 300 ? " ..." : ""}`);
}

export function toolCall(name: string, args: Record<string, unknown>): void {
  const a = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)?.slice(0, 80)}`)
    .join(" ");
  console.log(`${CYAN}→ ${name}(${a})${RESET}`);
}

export function toolResult(name: string, ok: boolean, output: string): void {
  const preview = output.split("\n")[0]?.slice(0, 120) ?? "";
  const icon = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`${icon} ${CYAN}${name}${RESET} ${DIM}→${RESET} ${preview}`);
}

export function buildStatus(success: boolean, output: string): void {
  const icon = success ? `${GREEN}✓ BUILD SUCCESS` : `${RED}✗ BUILD FAILED`;
  console.log(`\n${icon}${RESET}\n${output.split("\n").slice(-10).join("\n")}\n`);
}

export function header(msg: string): void {
  console.log(`\n${BOLD}${CYAN}── ${msg} ${"─".repeat(Math.max(2, 60 - msg.length))}${RESET}`);
}

/** Startup banner: a clean key/value box (plain-text fallback when piped). */
export function banner(title: string, rows: Array<[string, string]>): void {
  const keyWidth = Math.max(8, ...rows.map(([k]) => k.length));
  const inner = Math.max(
    title.length + 4,
    ...rows.map(([, v]) => keyWidth + Math.max(...String(v).split("\n").map((l) => l.length)) + 1),
  );
  console.log(`${BOLD}${CYAN}╭─ ${title} ${"─".repeat(Math.max(1, inner - title.length - 3))}╮${RESET}`);
  for (const [key, value] of rows) {
    const lines = String(value).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const k = (i === 0 ? key : "").padEnd(keyWidth);
      let v = lines[i];
      const maxV = inner - keyWidth - 1;
      if (v.length > maxV) v = v.slice(0, maxV - 1) + "…";
      const pad = Math.max(0, inner - 1 - keyWidth - v.length);
      console.log(`${BOLD}${CYAN}│${RESET} ${DIM}${k}${RESET}${v}${" ".repeat(pad)}${BOLD}${CYAN}│${RESET}`);
    }
  }
  console.log(`${BOLD}${CYAN}╰${"─".repeat(inner)}╯${RESET}`);
}

// ── Streaming helpers ────────────────────────────────────────────────────────

let _streamLine = "";
let _streamColor = CYAN;
let _streamPrefix = "";

/** Start a streaming line. Call llmStreamChunk() for each delta, then llmStreamEnd(). */
export function llmStreamStart(prefix = "assistant", color = CYAN): void {
  _streamLine = "";
  _streamColor = color;
  _streamPrefix = prefix;
  process.stdout.write(`${color}${prefix}:${RESET} `);
}

/** Append a text delta to the current streaming line. */
export function llmStreamChunk(delta: string): void {
  _streamLine += delta;
  process.stdout.write(delta);
}

/** Finish the streaming line (append suffix + newline). */
export function llmStreamEnd(suffix = ""): string {
  const line = _streamLine;
  _streamLine = "";
  process.stdout.write(`${suffix}\n`);
  return line;
}

// ── Tool output streaming (live run_command output) ─────────────────────────

const TOOL_STREAM_MAX_CHARS = 20_000;
let _toolStreamOpen = false;
let _toolStreamLineOpen = false; // last chunk did not end with "\n"
let _toolStreamChars = 0;

/** Begin a live tool-output block. Output is printed dimmed, capped at 20k chars. */
export function toolStreamStart(): void {
  if (_toolStreamOpen) return;
  _toolStreamOpen = true;
  _toolStreamLineOpen = false;
  _toolStreamChars = 0;
  process.stdout.write(`${DIM}┌ output${RESET}`);
}

/** Append a tool-output delta to the live block. */
export function toolStreamChunk(delta: string): void {
  if (!_toolStreamOpen) return;
  if (_toolStreamChars >= TOOL_STREAM_MAX_CHARS) return;
  _toolStreamChars += delta.length;
  if (_toolStreamChars >= TOOL_STREAM_MAX_CHARS) {
    // Include the tail of this chunk up to the cap, then stop rendering live.
    const keep = delta.slice(0, Math.max(0, delta.length - (_toolStreamChars - TOOL_STREAM_MAX_CHARS)));
    if (keep.length > 0) {
      process.stdout.write(`${DIM}${keep}${RESET}`);
      _toolStreamLineOpen = !keep.endsWith("\n");
    }
    process.stdout.write(`\n${DIM}│ (live output truncated at ${TOOL_STREAM_MAX_CHARS} chars — full output in the result)${RESET}`);
    return;
  }
  process.stdout.write(`\n${DIM}│ ${delta.replace(/\n/g, `\n${DIM}│ ${RESET}`)}${RESET}`);
  _toolStreamLineOpen = !delta.endsWith("\n");
}

/** Finish the live tool-output block (closes the partial last line). */
export function toolStreamEnd(): void {
  if (!_toolStreamOpen) return;
  _toolStreamOpen = false;
  process.stdout.write(_toolStreamLineOpen ? `\n${DIM}└${RESET}\n` : `${DIM}└${RESET}\n`);
}

/** True while a live tool-output block is open. */
export function isToolStreamOpen(): boolean {
  return _toolStreamOpen;
}

// ── Diff rendering ───────────────────────────────────────────────────────────

/** Print a unified diff with colors (+ green, - red, @@ cyan). */
export function printDiff(diffText: string): void {
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      console.log(`${BOLD}${line}${RESET}`);
    } else if (line.startsWith("+")) {
      console.log(`${GREEN}${line}${RESET}`);
    } else if (line.startsWith("-")) {
      console.log(`${RED}${line}${RESET}`);
    } else if (line.startsWith("@@")) {
      console.log(`${CYAN}${line}${RESET}`);
    } else {
      console.log(line);
    }
  }
}

/** Print a one-line diff summary: "✎ +12 -3 lines → src/foo.ts". */
export function diffSummary(path: string, added: number, removed: number): void {
  console.log(`${CYAN}✎${RESET} ${BOLD}${path}${RESET} ${GREEN}+${added}${RESET} ${RED}-${removed}${RESET} lines`);
}
