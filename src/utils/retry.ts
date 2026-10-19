import { DomainwrightError } from '../core/errors.js';

export interface RetryPolicy {
  /** Maximum number of attempts, including the first one. Default 4. */
  maxAttempts: number;
  /** Delay before the first retry. Default 500 ms. */
  initialDelayMs: number;
  /** Upper bound for a single delay, including server-requested delays. Default 30 s. */
  maxDelayMs: number;
  /** Exponential growth factor. Default 2. */
  factor: number;
  /** Apply full jitter to computed delays. Default true. */
  jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: true,
};

export function resolveRetryPolicy(policy?: Partial<RetryPolicy> | false): RetryPolicy {
  if (policy === false) return { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 };
  const merged = { ...DEFAULT_RETRY_POLICY, ...policy };
  if (!Number.isInteger(merged.maxAttempts) || merged.maxAttempts < 1) merged.maxAttempts = 1;
  return merged;
}

/** Delay before retry number `attempt` (1-based count of failures so far). */
export function computeBackoff(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.factor ** Math.max(0, attempt - 1));
  return policy.jitter ? Math.round(exp / 2 + (random() * exp) / 2) : exp;
}

export function abortError(signal?: AbortSignal): DomainwrightError {
  const reason: unknown = signal?.reason;
  if (reason instanceof DomainwrightError) return reason;
  return new DomainwrightError('ABORTED', 'The operation was cancelled', { cause: reason });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Sleep that rejects with an `ABORTED` error when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Parse `Retry-After` (seconds or HTTP date) or an epoch-seconds reset header
 * such as `X-RateLimit-Reset` into a delay in milliseconds.
 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const value = Number(reset);
    if (Number.isFinite(value)) {
      // Epoch seconds (name.com) vs. relative seconds (some providers).
      return value > 1_000_000_000 ? Math.max(0, value * 1000 - now) : Math.max(0, value * 1000);
    }
  }
  return undefined;
}
