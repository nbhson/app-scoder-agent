import process from "node:process";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export function info(msg: string): void {
  console.log(`${DIM}[${ts()}]${RESET} ${msg}`);
}

export function step(stepNum: number, total: number, msg: string): void {
  console.log(`${BLUE}[${stepNum}/${total}]${RESET} ${BOLD}${msg}${RESET}`);
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
  console.log(`${icon} ${CYAN}${name}${RESET} → ${preview}`);
}

export function buildStatus(success: boolean, output: string): void {
  const icon = success ? `${GREEN}✓ BUILD SUCCESS` : `${RED}✗ BUILD FAILED`;
  console.log(`\n${icon}${RESET}\n${output.split("\n").slice(-10).join("\n")}\n`);
}

export function header(msg: string): void {
  console.log(`\n${BOLD}${CYAN}── ${msg} ${"─".repeat(Math.max(2, 60 - msg.length))}${RESET}`);
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
