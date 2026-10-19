/**
 * Public DNS lookups over DNS-over-HTTPS (JSON API). Works anywhere `fetch` works,
 * including Cloudflare Workers, which have no raw DNS sockets.
 */

import { DomainPilotError, isDomainPilotError } from '../core/errors.js';
import { HttpClient } from '../core/http.js';
import type { RequestOptions } from '../core/types.js';

export type ResolvableType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'NS';

export interface DnsAnswer {
  /**
   * - `ok`: records of the requested type were returned.
   * - `nodata`: the name exists but has no records of this type.
   * - `nxdomain`: the name does not exist.
   * - `error`: the lookup failed (SERVFAIL, network, ...).
   */
  status: 'ok' | 'nodata' | 'nxdomain' | 'error';
  /** Values of the requested type, normalized (no trailing dots, TXT strings joined and unquoted). */
  values: string[];
  /** Every answer record, including CNAME chain entries. */
  answers: { name: string; type: string; data: string; ttl: number }[];
  error?: string;
}

export interface DnsResolver {
  resolve(name: string, type: ResolvableType, options?: RequestOptions): Promise<DnsAnswer>;
}

const TYPE_CODES: Record<number, string> = { 1: 'A', 2: 'NS', 5: 'CNAME', 16: 'TXT', 28: 'AAAA' };

export const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';

interface DohResponse {
  Status?: number;
  Answer?: { name: string; type: number; TTL: number; data: string }[];
}

/** Decode TXT presentation data such as `"part one" "part two"` into `part onepart two`. */
export function decodeTxt(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return data;
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
}

export class DohResolver implements DnsResolver {
  constructor(
    private readonly http: HttpClient,
    private readonly endpoint: string = DEFAULT_DOH_URL,
  ) {}

  async resolve(name: string, type: ResolvableType, options: RequestOptions = {}): Promise<DnsAnswer> {
    let body: DohResponse;
    try {
      const response = await this.http.request({
        method: 'GET',
        url: this.endpoint,
        query: { name, type },
        headers: { accept: 'application/dns-json' },
        operation: `doh.${type}`,
        provider: 'dns',
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (response.status !== 200) {
        return { status: 'error', values: [], answers: [], error: `DoH HTTP ${response.status}` };
      }
      body = response.body ?? {};
    } catch (error) {
      if (isDomainPilotError(error, 'ABORTED')) throw error;
      return {
        status: 'error',
        values: [],
        answers: [],
        error: error instanceof DomainPilotError ? error.code : 'lookup failed',
      };
    }

    if (body.Status === 3) return { status: 'nxdomain', values: [], answers: [] };
    if (body.Status !== 0)
      return { status: 'error', values: [], answers: [], error: `DNS rcode ${String(body.Status)}` };

    const answers = (body.Answer ?? []).map((a) => ({
      name: a.name.replace(/\.$/, '').toLowerCase(),
      type: TYPE_CODES[a.type] ?? String(a.type),
      data: a.data,
      ttl: a.TTL,
    }));
    const values = answers
      .filter((a) => a.type === type)
      .map((a) => (type === 'TXT' ? decodeTxt(a.data) : a.data.replace(/\.$/, '').toLowerCase()));
    return { status: values.length ? 'ok' : 'nodata', values, answers };
  }
}

export function createDohResolver(options: { endpoint?: string; http?: HttpClient } = {}): DohResolver {
  return new DohResolver(options.http ?? new HttpClient({ timeoutMs: 10_000 }), options.endpoint);
}
