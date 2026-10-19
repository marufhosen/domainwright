/**
 * Low-level Cloudflare API v4 transport: envelope parsing, pagination and error mapping.
 */

import { ProviderError, type ErrorCode, type ProviderErrorDetail } from '../core/errors.js';
import type { HttpClient, HttpMethod, QueryValue } from '../core/http.js';

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  messages?: unknown[];
  result?: T;
  result_info?: { page?: number; per_page?: number; total_pages?: number; count?: number; total_count?: number };
}

export interface CloudflareRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  idempotent?: boolean;
  operation: string;
  signal?: AbortSignal;
}

/** Cloudflare error codes that indicate the resource already exists. */
// Only codes observed in Cloudflare's documented responses are mapped; everything else
// is classified by HTTP status.
const CONFLICT_CODES = new Set([1061, 81053, 81057]);
const AUTH_CODES = new Set([10000]);
const PERMISSION_CODES = new Set([9109]);
const NOT_FOUND_CODES = new Set([7003]);

export class CloudflareApi {
  constructor(
    private readonly http: HttpClient,
    private readonly apiToken: string,
    readonly accountId: string,
    private readonly baseUrl: string = CLOUDFLARE_API_BASE,
  ) {}

  async request<T>(req: CloudflareRequest): Promise<T> {
    const { body } = await this.send<T>(req);
    return body.result as T;
  }

  /** Iterate every page of a paginated list endpoint. */
  async list<T>(req: Omit<CloudflareRequest, 'method'> & { perPage?: number; maxPages?: number }): Promise<T[]> {
    const perPage = req.perPage ?? 50;
    const maxPages = req.maxPages ?? 100;
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const { body } = await this.send<T[]>({
        ...req,
        method: 'GET',
        query: { ...req.query, page, per_page: perPage },
      });
      const result = Array.isArray(body.result) ? body.result : [];
      items.push(...result);
      const totalPages = body.result_info?.total_pages;
      if (totalPages !== undefined ? page >= totalPages : result.length < perPage) break;
    }
    return items;
  }

  private async send<T>(req: CloudflareRequest): Promise<{ body: Envelope<T> }> {
    const response = await this.http.request({
      method: req.method,
      url: `${this.baseUrl}${req.path}`,
      query: req.query,
      body: req.body,
      headers: { authorization: `Bearer ${this.apiToken}` },
      idempotent: req.idempotent,
      signal: req.signal,
      operation: req.operation,
      provider: 'cloudflare',
    });
    const body = (response.body ?? {}) as Envelope<T>;
    const ok = response.status >= 200 && response.status < 300 && body.success !== false;
    if (!ok) throw toCloudflareError(response.status, body, req.operation);
    return { body };
  }
}

export function toCloudflareError(status: number, body: Envelope<unknown>, operation: string): ProviderError {
  const providerErrors: ProviderErrorDetail[] = (body.errors ?? [])
    .filter((e) => typeof e.message === 'string')
    .map((e) => ({ ...(e.code === undefined ? {} : { code: e.code }), message: String(e.message).slice(0, 500) }));
  const codes = new Set(providerErrors.map((e) => Number(e.code)));
  const has = (set: Set<number>): boolean => [...codes].some((c) => set.has(c));

  let code: ErrorCode = 'PROVIDER_ERROR';
  if (status === 401 || has(AUTH_CODES)) code = 'AUTHENTICATION_FAILED';
  else if (status === 403 || has(PERMISSION_CODES)) code = 'PERMISSION_DENIED';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status === 409 || has(CONFLICT_CODES)) code = 'CONFLICT';
  else if (status === 404 || has(NOT_FOUND_CODES)) code = 'NOT_FOUND';

  const retryable = code === 'RATE_LIMITED' || status >= 500;
  const summary = providerErrors[0]?.message ?? `HTTP ${status}`;
  return new ProviderError(code, `Cloudflare ${operation} failed: ${summary}`, {
    provider: 'cloudflare',
    status,
    retryable,
    providerErrors,
    details: { operation },
  });
}
