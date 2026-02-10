import type { Logger } from "pino";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  logger?: Logger;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

/** HTTP status codes that are safe to retry. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

/**
 * Determine if a 403 is a rate limit error (vs. a permission error).
 * GitHub sets `x-ratelimit-remaining: 0` and/or includes a `retry-after`
 * header when the request was rate-limited.
 */
function isRateLimited403(error: any): boolean {
  const headers = error.response?.headers ?? error.headers ?? {};
  if (headers["retry-after"]) return true;
  if (headers["x-ratelimit-remaining"] === "0") return true;
  return false;
}

function isRetryable(error: any): boolean {
  const status: number | undefined = error.status ?? error.response?.status;
  if (!status) return false;

  if (RETRYABLE_STATUSES.has(status)) return true;
  if (status === 403 && isRateLimited403(error)) return true;

  return false;
}

function getRetryAfterMs(error: any): number | null {
  const headers = error.response?.headers ?? error.headers ?? {};
  const retryAfter = headers["retry-after"];
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with automatic retry on transient/rate-limit errors.
 *
 * Retries on: 429, 500, 502, 503, and 403 with rate-limit headers.
 * Uses exponential backoff (1s, 2s, 4s) or `Retry-After` header.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const logger = opts?.logger;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (attempt === maxRetries || !isRetryable(error)) {
        throw error;
      }

      const retryAfterMs = getRetryAfterMs(error);
      const delayMs = retryAfterMs ?? baseDelayMs * Math.pow(2, attempt);

      if (logger) {
        logger.warn(
          {
            attempt: attempt + 1,
            maxRetries,
            status: error.status ?? error.response?.status,
            retryAfterMs: delayMs,
          },
          "Retrying GitHub API request",
        );
      }

      await sleep(delayMs);
    }
  }

  // Should not reach here, but just in case
  throw lastError;
}
