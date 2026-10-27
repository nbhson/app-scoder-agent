/**
 * Retry with exponential backoff + jitter for transient failures.
 */

export interface RetryOptions {
  maxRetries?: number; // default 3
  baseDelayMs?: number; // default 1000
  maxDelayMs?: number; // default 30000
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Run fn with retries. Retries on retryable HTTP statuses (thrown as errors
 * carrying `.status`) and network errors. Client errors (4xx except 429)
 * fail immediately via NonRetryableError semantics.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
  onRetry?: (attempt: number, delayMs: number, reason: string) => void,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const status = (err as { status?: number }).status;
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

      // Respect Retry-After header if present (seconds)
      const retryAfter = (err as { retryAfterMs?: number }).retryAfterMs;
      const jitter = Math.floor(Math.random() * 500);
      const delay = Math.min(
        retryAfter ?? baseDelayMs * 2 ** attempt + jitter,
        maxDelayMs,
      );

      onRetry?.(attempt + 1, delay, status ? `HTTP ${status}` : String((err as Error).message).slice(0, 80));
      await sleep(delay);
    }
  }
  throw lastErr; // unreachable
}
