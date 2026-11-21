/**
 * P6 — desktop notification when a run finishes while the terminal is away.
 *
 * Transport: OSC 777 (`notify;<title>;<body>`), understood by iTerm2, kitty
 * and VTE-family terminals; every other terminal ignores it harmlessly — the
 * trailing BEL is the fallback "it rang somewhere". Pure builders so the
 * decision matrix is unit-testable without a TTY.
 */

export type NotifyStatus = "success" | "failed";

/** Only ever write escapes to a real alt-screen terminal, never `dumb`. */
export function notifyCapable(stdout: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return stdout.isTTY === true && (env.TERM ?? "xterm") !== "dumb";
}

/** Strip control bytes + clamp — the summary is LLM text, never trust it. */
export function sanitizeBody(s: string, max = 90): string {
  // eslint-disable-next-line no-control-regex -- stripping escape/BEL bytes from LLM text is the whole point
  const clean = s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Build the full escape string (title/body sanitized). */
export function buildNotify(title: string, body: string): string {
  const t = sanitizeBody(title, 24);
  const b = sanitizeBody(body, 120);
  return `\x1b]777;notify;${t};${b}\x07\x07`; // OSC 777 + BEL fallback
}

/** "success · Fixed the flaky test" — the notification body. */
export function notifyBody(status: NotifyStatus, summary: string, stepCount: number, durationMs: number): string {
  const label = status === "success" ? "done" : "FAILED";
  const mins = Math.floor(durationMs / 60_000);
  const secs = Math.round((durationMs % 60_000) / 1000);
  const time = mins > 0 ? `${mins}m${String(secs).padStart(2, "0")}s` : `${secs}s`;
  const steps = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
  return `${label} · ${steps} · ${time} · ${sanitizeBody(summary, 70)}`;
}

export interface NotifyDecision {
  /** rc/env switch was on when the run finished. */
  enabled: boolean;
  /** Last known focus state (default true until a focus-out is observed). */
  focused: boolean;
  /** Did the terminal ever report focus (DEC 1004 honored)? */
  sawFocusEvents: boolean;
  durationMs: number;
  /** Fallback threshold for terminals without focus reporting (default 45s). */
  thresholdMs?: number;
}

/**
 * Decision matrix:
 *  - focus reporting available  → notify only while UNFOCUSED;
 *  - no focus reporting         → notify when the run was LONG (>threshold);
 *  - disabled by config/env     → never.
 */
export function shouldNotify(d: NotifyDecision): boolean {
  if (!d.enabled) return false;
  if (d.sawFocusEvents) return !d.focused;
  return d.durationMs > (d.thresholdMs ?? 45_000);
}

/** Write the escape — returns false when the terminal can't take it. */
export function emitNotify(text: string, stdout: NodeJS.WritableStream & { isTTY?: boolean } = process.stdout): boolean {
  if (!notifyCapable(stdout)) return false;
  try {
    stdout.write(text);
    return true;
  } catch {
    return false;
  }
}
