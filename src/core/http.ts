/**
 * Minimal HTTP transport built on the standard `fetch` API.
 *
 * Responsibilities: per-request timeouts, cancellation, rate-limit aware retries
 * with exponential backoff, and *safe* retry semantics. Requests that are not
 * idempotent (POST/PATCH without an idempotency guarantee) are only retried when
 * the server explicitly rejected them before processing (HTTP 429).
 */

import { DomainPilotError } from './errors.js';
import type { Logger } from './logger.js';
import { noopLogger } from './logger.js';
import {
  type RetryPolicy,
  abortError,
  computeBackoff,
  parseRetryAfter,
  resolveRetryPolicy,
  sleep,
} from '../utils/retry.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type QueryValue = string | number | boolean | undefined | null | readonly (string | number)[];

export interface HttpOptions {
  /** Custom fetch implementation (tests, proxies, instrumentation). Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout. Default 30 000 ms. */
  timeoutMs?: number;
  /** Retry policy for transient failures, or `false` to disable retries. */
  retry?: Partial<RetryPolicy> | false;
  /** Value sent as `User-Agent` where the runtime allows it. */
  userAgent?: string;
}

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** JSON body. */
  body?: unknown;
  /**
   * Whether the request can be safely repeated. Defaults to true for GET, PUT and
   * DELETE and false for POST and PATCH.
   */
  idempotent?: boolean;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy> | false;
  signal?: AbortSignal;
  /** Short operation name used in logs, e.g. `cloudflare.zones.list`. */
  operation: string;
  /** Provider name used in errors. */
  provider: string;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or `undefined` for empty / non-JSON bodies. */
  body: unknown;
  attempts: number;
}

const RETRYABLE_STATUS_IDEMPOTENT = new Set([408, 429, 500, 502, 503, 504]);

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly userAgent: string | undefined;
  private readonly logger: Logger;

  constructor(options: HttpOptions = {}, logger: Logger = noopLogger) {
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    const impl = options.fetch ?? (globalFetch ? globalFetch.bind(globalThis) : undefined);
    if (!impl) {
      throw new DomainPilotError('CONFIGURATION_ERROR', 'No fetch implementation available; pass http.fetch');
    }
    this.fetchImpl = impl;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retry = resolveRetryPolicy(options.retry);
    this.userAgent = options.userAgent;
    this.logger = logger;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const policy =
      req.retry === undefined
        ? this.retry
        : resolveRetryPolicy(req.retry === false ? false : { ...this.retry, ...req.retry });
    const idempotent = req.idempotent ?? (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE');
    const url = buildUrl(req.url, req.query);
    const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    if (this.userAgent) headers['user-agent'] = this.userAgent;
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, { method: req.method, headers, body }, req);
      } catch (error) {
        const failure = error instanceof DomainPilotError ? error : networkError(req, error);
        // A timeout or connection failure on a non-idempotent request has an unknown
        // outcome: the server may have processed it. Never retry those.
        const canRetry = idempotent && failure.code !== 'ABORTED' && attempt < policy.maxAttempts;
        this.logger.warn('http request failed', {
          operation: req.operation,
          attempt,
          code: failure.code,
          willRetry: canRetry,
        });
        if (!canRetry) throw failure;
        await sleep(computeBackoff(attempt, policy), req.signal);
        continue;
      }

      const parsed = await parseBody(response);
      this.logger.debug('http response', {
        operation: req.operation,
        method: req.method,
        status: response.status,
        attempt,
        durationMs: Date.now() - started,
      });

      const retryableStatus = idempotent ? RETRYABLE_STATUS_IDEMPOTENT.has(response.status) : response.status === 429; // rejected before processing; safe for any method
      if (retryableStatus && attempt < policy.maxAttempts) {
        const serverDelay = parseRetryAfter(response.headers);
        const delay = Math.min(policy.maxDelayMs, serverDelay ?? computeBackoff(attempt, policy));
        this.logger.info('retrying after transient response', {
          operation: req.operation,
          status: response.status,
          attempt,
          delayMs: delay,
        });
        await sleep(delay, req.signal);
        continue;
      }
      return { status: response.status, headers: response.headers, body: parsed, attempts: attempt };
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, req: HttpRequest): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => {
      controller.abort();
    };
    if (req.signal?.aborted) {
      clearTimeout(timer);
      throw abortError(req.signal);
    }
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (req.signal?.aborted) throw abortError(req.signal);
      if (timedOut) {
        throw new DomainPilotError('TIMEOUT', `${req.provider} request timed out after ${timeoutMs} ms`, {
          provider: req.provider,
          retryable: true,
          details: { operation: req.operation },
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function networkError(req: HttpRequest, cause: unknown): DomainPilotError {
  return new DomainPilotError('NETWORK_ERROR', `Could not reach ${req.provider}`, {
    provider: req.provider,
    retryable: true,
    details: { operation: req.operation },
    cause,
  });
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function buildUrl(base: string, query?: Record<string, QueryValue>): string {
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.append(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${qs}`;
}
