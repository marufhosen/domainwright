/**
 * HTTPS reachability probe. A completed HTTPS response proves that DNS resolves, that
 * a certificate valid for the hostname is served (fetch rejects invalid certificates),
 * and that something answers. Optional expectations confirm it is the intended
 * application, not a parking page or another tenant's Worker.
 */

import type { FetchLike } from '../core/http.js';
import type { RequestOptions } from '../core/types.js';

export interface HttpsExpectation {
  /** Path to request. Default `/`. A dedicated health endpoint is recommended. */
  path?: string;
  /** Acceptable status codes. Default: any status below 500. */
  status?: number[];
  /** A response header that must be present, optionally with an exact value. */
  header?: { name: string; value?: string };
  /** Text the response body must contain. */
  bodyIncludes?: string;
  /** Per-request timeout. Default 10 000 ms. */
  timeoutMs?: number;
}

export interface ReachabilityResult {
  hostname: string;
  url: string;
  outcome: 'ok' | 'unexpected-response' | 'tls-or-network-error' | 'timeout';
  status?: number;
  message: string;
}

export async function probeHttps(
  fetchImpl: FetchLike,
  hostname: string,
  expect: HttpsExpectation = {},
  options: RequestOptions = {},
): Promise<ReachabilityResult> {
  const path = expect.path ?? '/';
  const url = `https://${hostname}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, expect.timeoutMs ?? 10_000);
  const onAbort = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    const okStatus = expect.status ? expect.status.includes(response.status) : response.status < 500;
    if (!okStatus) {
      return {
        hostname,
        url,
        outcome: 'unexpected-response',
        status: response.status,
        message: `Unexpected HTTP ${response.status}`,
      };
    }
    if (expect.header) {
      const value = response.headers.get(expect.header.name);
      if (value === null || (expect.header.value !== undefined && value !== expect.header.value)) {
        return {
          hostname,
          url,
          outcome: 'unexpected-response',
          status: response.status,
          message: `Response header ${expect.header.name} did not match; the hostname may not be served by the intended Worker`,
        };
      }
    }
    if (expect.bodyIncludes !== undefined) {
      const text = await response.text();
      if (!text.includes(expect.bodyIncludes)) {
        return {
          hostname,
          url,
          outcome: 'unexpected-response',
          status: response.status,
          message: 'Response body did not contain the expected text',
        };
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    return {
      hostname,
      url,
      outcome: 'ok',
      status: response.status,
      message: `HTTPS responded with ${response.status}`,
    };
  } catch {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
    if (timedOut) return { hostname, url, outcome: 'timeout', message: 'HTTPS request timed out' };
    return {
      hostname,
      url,
      outcome: 'tls-or-network-error',
      message: 'HTTPS request failed (DNS, TLS certificate or connection error)',
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
