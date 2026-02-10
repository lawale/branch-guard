import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../../src/services/retry.js";

function createError(status: number, headers: Record<string, string> = {}): any {
  const error: any = new Error(`HTTP ${status}`);
  error.status = status;
  error.response = { headers };
  return error;
}

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on first try without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds on second attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(createError(429))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100); // 100ms * 2^0
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 and succeeds on third attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(createError(503))
      .mockRejectedValueOnce(createError(503))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100); // attempt 1: 100ms * 2^0
    await vi.advanceTimersByTimeAsync(200); // attempt 2: 100ms * 2^1
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on 500 and 502", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(createError(500))
      .mockRejectedValueOnce(createError(502))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects Retry-After header", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(createError(429, { "retry-after": "5" }))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    // Should use Retry-After (5000ms) instead of exponential backoff (100ms)
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 404", async () => {
    const fn = vi.fn().mockRejectedValue(createError(404));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 100 }),
    ).rejects.toThrow("HTTP 404");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 403 without rate limit headers", async () => {
    const fn = vi.fn().mockRejectedValue(createError(403));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 100 }),
    ).rejects.toThrow("HTTP 403");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 403 with x-ratelimit-remaining: 0", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        createError(403, { "x-ratelimit-remaining": "0" }),
      )
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 403 with retry-after header", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        createError(403, { "retry-after": "2" }),
      )
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws original error", async () => {
    vi.useRealTimers();

    const error = createError(503);
    const fn = vi.fn().mockImplementation(() => {
      throw error;
    });

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow("HTTP 503");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries

    vi.useFakeTimers();
  });

  it("uses exponential backoff timing", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(createError(429))
      .mockRejectedValueOnce(createError(429))
      .mockRejectedValueOnce(createError(429))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 1000 });

    // After 999ms, still only 1 call (waiting for first retry)
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);

    // At 1000ms (1000 * 2^0), second attempt fires
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    // At 2000ms more (1000 * 2^1), third attempt fires
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(3);

    // At 4000ms more (1000 * 2^2), fourth attempt fires
    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(4);

    const result = await promise;
    expect(result).toBe("ok");
  });

  it("logs warnings on each retry when logger provided", async () => {
    const logger = {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as any;

    const fn = vi
      .fn()
      .mockRejectedValueOnce(createError(429))
      .mockRejectedValueOnce(createError(503))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      logger,
    });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, status: 429 }),
      "Retrying GitHub API request",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2, status: 503 }),
      "Retrying GitHub API request",
    );
  });
});
