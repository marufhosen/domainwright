import { describe, expect, it, vi } from 'vitest';
import { HttpClient, isDomainwrightError } from '../../src/index.js';
import { parseRetryAfter } from '../../src/utils/retry.js';

const fast = { initialDelayMs: 1, maxDelayMs: 5, jitter: false };

function sequence(responses: (Response | Error)[]): { fetch: typeof fetch; calls: () => number } {
  let i = 0;
  const fn = vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (next instanceof Error) throw next;
    return next.clone();
  });
  return { fetch: fn, calls: () => fn.mock.calls.length };
}

const req = { url: 'https://api.example.test/x', operation: 'test', provider: 'test' } as const;

describe('HttpClient retries', () => {
  it('retries idempotent requests on 5xx and succeeds', async () => {
    const s = sequence([
      new Response('', { status: 503 }),
      new Response('', { status: 502 }),
      Response.json({ ok: 1 }),
    ]);
    const http = new HttpClient({ fetch: s.fetch, retry: fast });
    const res = await http.request({ ...req, method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(3);
  });

  it('honours Retry-After on 429 for any method', async () => {
    const s = sequence([new Response('', { status: 429, headers: { 'retry-after': '0' } }), Response.json({ ok: 1 })]);
    const http = new HttpClient({ fetch: s.fetch, retry: fast });
    const res = await http.request({ ...req, method: 'POST', body: {} });
    expect(res.status).toBe(200);
    expect(s.calls()).toBe(2);
  });

  it('never retries a non-idempotent POST after a 5xx or a network failure', async () => {
    const s1 = sequence([new Response('', { status: 504 }), Response.json({ ok: 1 })]);
    const res = await new HttpClient({ fetch: s1.fetch, retry: fast }).request({ ...req, method: 'POST', body: {} });
    expect(res.status).toBe(504);
    expect(s1.calls()).toBe(1);

    const s2 = sequence([new TypeError('fetch failed'), Response.json({ ok: 1 })]);
    await expect(
      new HttpClient({ fetch: s2.fetch, retry: fast }).request({ ...req, method: 'POST', body: {} }),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(s2.calls()).toBe(1);
  });

  it('retries POST when explicitly marked idempotent', async () => {
    const s = sequence([new TypeError('fetch failed'), Response.json({ ok: 1 })]);
    const res = await new HttpClient({ fetch: s.fetch, retry: fast }).request({
      ...req,
      method: 'POST',
      body: {},
      idempotent: true,
    });
    expect(res.status).toBe(200);
  });

  it('stops after maxAttempts and returns the last response', async () => {
    const s = sequence([new Response('', { status: 500 })]);
    const res = await new HttpClient({ fetch: s.fetch, retry: { ...fast, maxAttempts: 3 } }).request({
      ...req,
      method: 'GET',
    });
    expect(res.status).toBe(500);
    expect(s.calls()).toBe(3);
  });

  it('times out slow requests', async () => {
    const slow = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const http = new HttpClient({ fetch: slow, timeoutMs: 10, retry: false });
    await expect(http.request({ ...req, method: 'GET' })).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
  });

  it('supports cancellation', async () => {
    const controller = new AbortController();
    const slow = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const http = new HttpClient({ fetch: slow, timeoutMs: 5_000 });
    const pending = http.request({ ...req, method: 'GET', signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(isDomainwrightError(error, 'ABORTED')).toBe(true);
  });

  it('parses Retry-After and X-RateLimit-Reset', () => {
    const now = 1_700_000_000_000;
    expect(parseRetryAfter(new Headers({ 'retry-after': '2' }), now)).toBe(2000);
    expect(parseRetryAfter(new Headers({ 'x-ratelimit-reset': String(now / 1000 + 3) }), now)).toBe(3000);
    expect(parseRetryAfter(new Headers(), now)).toBeUndefined();
  });
});
