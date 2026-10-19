import { sleep, throwIfAborted } from './retry.js';

export interface PollOptions {
  /** Total time budget. Default 300 000 ms (5 minutes). */
  timeoutMs?: number;
  /** Delay between attempts. Default 10 000 ms. */
  intervalMs?: number;
  /** Upper bound for the delay when `backoffFactor` > 1. Default 60 000 ms. */
  maxIntervalMs?: number;
  /** Multiply the interval after each attempt. Default 1.5. */
  backoffFactor?: number;
  signal?: AbortSignal;
}

export interface PollAttempt<T> {
  /** Stop polling and return this value. */
  done: boolean;
  value: T;
}

export interface PollResult<T> {
  value: T;
  /** True when the time budget ran out before `done` was reported. */
  timedOut: boolean;
  attempts: number;
  elapsedMs: number;
}

/**
 * Repeatedly call `attempt` until it reports `done`, the timeout elapses, or the
 * signal aborts. The last value is always returned so callers can report the
 * most recent observed state on timeout instead of a bare error.
 */
export async function poll<T>(
  attempt: (attemptNumber: number) => Promise<PollAttempt<T>>,
  options: PollOptions = {},
): Promise<PollResult<T>> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  let interval = options.intervalMs ?? 10_000;
  const maxInterval = options.maxIntervalMs ?? 60_000;
  const factor = options.backoffFactor ?? 1.5;
  const started = Date.now();
  let attempts = 0;

  for (;;) {
    throwIfAborted(options.signal);
    attempts += 1;
    const result = await attempt(attempts);
    const elapsedMs = Date.now() - started;
    if (result.done) return { value: result.value, timedOut: false, attempts, elapsedMs };
    const remaining = timeoutMs - elapsedMs;
    if (remaining <= 0) return { value: result.value, timedOut: true, attempts, elapsedMs };
    await sleep(Math.min(interval, remaining), options.signal);
    interval = Math.min(maxInterval, interval * factor);
  }
}
