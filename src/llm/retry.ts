/**
 * Retry with escalating waits for transient LLM/API failures.
 *
 * Default schedule is a FIXED LADDER of growing waits — 10s, 30s, 1m, 3m,
 * 5m, 10m — so a rate-limited (429 quota window) or briefly overloaded
 * provider is ridden out instead of failing the run after a few fast
 * retries. Every wait is interruptible via `signal` (Ctrl-C / abort must
 * never be stuck behind a pending sleep).
 */

export interface RetryOptions {
  /** Default: one retry per RETRY_LADDER_MS step (6 retries, 7 attempts). */
  maxRetries?: number;
  /**
   * Legacy exponential mode: setting this opts OUT of the ladder
   * (delay = baseDelayMs * 2^attempt, capped at maxDelayMs). Used by tests
   * and callers that need sub-second retries.
   */
  baseDelayMs?: number;
  /** Cap for legacy exponential mode (default 30s). Ladder mode ignores it. */
  maxDelayMs?: number;
  /** Aborting this signal interrupts a pending backoff sleep immediately. */
  signal?: AbortSignal;
}

/** Escalating retry waits: 10s → 30s → 1m → 3m → 5m → 10m. */
export const RETRY_LADDER_MS = [10_000, 30_000, 60_000, 180_000, 300_000, 600_000];

/**
 * Effective ladder — SCODER_RETRY_LADDER_MS (comma-separated) overrides it so
 * CI and tests can ride through a full retry cycle in milliseconds instead of
 * minutes. Non-numeric / non-positive segments (including blanks) are ignored.
 */
export function retryLadderMs(): number[] {
  const raw = process.env.SCODER_RETRY_LADDER_MS;
  if (raw) {
    const parts = raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (parts.length > 0) return parts;
  }
  return RETRY_LADDER_MS;
}

/** Human wait label for logs: 10s … 45s … 1m … 10m. */
export function formatRetryDelay(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

/** Ceiling for a server-supplied Retry-After — never wait absurdly long. */
const RETRY_AFTER_CAP_MS = 15 * 60_000;

export class NonRetryableError extends Error {}

/** HTTP statuses worth retrying (transient). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Network-level errors worth retrying. */
export function isRetryableNetworkError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  return (
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network|fetch failed/i.test(msg)
  );
}

/** Sleep that rejects as soon as `signal` aborts (a 10m wait must end on Ctrl-C). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) {
      rej(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      rej(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run fn with retries. Retries on retryable HTTP statuses (thrown as errors
 * carrying `.status`) and network errors. Client errors (4xx except 429)
 * fail immediately via NonRetryableError semantics. A real `Retry-After`
 * header always beats the ladder (capped at 15m).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
  onRetry?: (attempt: number, delayMs: number, reason: string) => void,
): Promise<T> {
  const legacy = opts.baseDelayMs !== undefined;
  const ladder = legacy ? [] : retryLadderMs();
  const maxRetries = opts.maxRetries ?? (legacy ? 4 : ladder.length);
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const status = (err as { status?: number }).status;
      // WARMUP: abort của CHÍNH caller (warm-up bị lượt thật supersede, SIGINT)
      // không bao giờ được retry — message có thể là bất kỳ chuỗi nào.
      if ((err as { name?: string })?.name === "AbortError") throw err;
      const retryable =
        (typeof status === "number" && isRetryableStatus(status)) ||
        (!(err instanceof NonRetryableError) && isRetryableNetworkError(err));

      // Client errors (except 429) — fail immediately
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      if (!retryable || attempt === maxRetries) {
        throw err;
      }

      // Escalating wait: server's Retry-After wins (capped); otherwise the
      // ladder step (10s, 30s, 1m, 3m, 5m, 10m) or legacy 2^n backoff.
      const retryAfter = (err as { retryAfterMs?: number }).retryAfterMs;
      const scheduled = legacy
        ? Math.min(baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 500), maxDelayMs)
        : ladder[Math.min(attempt, ladder.length - 1)] + Math.floor(Math.random() * 500);
      const delay =
        retryAfter !== undefined && retryAfter > 0
          ? Math.min(retryAfter, RETRY_AFTER_CAP_MS)
          : scheduled;

      onRetry?.(attempt + 1, delay, status ? `HTTP ${status}` : String((err as Error).message).slice(0, 80));
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr; // unreachable
}
