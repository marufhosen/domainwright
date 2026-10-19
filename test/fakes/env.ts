/**
 * A fake "internet" for tests: Cloudflare API, name.com API, a DNS-over-HTTPS resolver
 * whose answers can be set per name, and HTTPS endpoints for reachability probes.
 * No test touches the real network.
 */

import { Domainwright, type DomainwrightConfig } from '../../src/index.js';
import { FakeCloudflare } from './cloudflare.js';
import { FakeNameCom } from './namecom.js';

type DohType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'NS';
const TYPE_CODE: Record<DohType, number> = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28 };

export class FakeDns {
  private readonly records = new Map<string, { type: DohType; data: string }[]>();
  failing = false;

  set(name: string, type: DohType, values: string[]): void {
    const key = name.toLowerCase();
    const others = (this.records.get(key) ?? []).filter((r) => r.type !== type);
    this.records.set(key, [...others, ...values.map((data) => ({ type, data: type === 'TXT' ? `"${data}"` : data }))]);
  }

  clear(name: string): void {
    this.records.delete(name.toLowerCase());
  }

  handle(url: URL): Response {
    if (this.failing) return new Response('fail', { status: 502 });
    const name = (url.searchParams.get('name') ?? '').toLowerCase();
    const type = url.searchParams.get('type') as DohType;
    const all = this.records.get(name);
    if (!all) return Response.json({ Status: 3 });
    const answers = all
      .filter((r) => r.type === type)
      .map((r) => ({ name: `${name}.`, type: TYPE_CODE[type], TTL: 300, data: r.data }));
    return Response.json({ Status: 0, Answer: answers });
  }
}

export const ACCOUNT_ID = 'a'.repeat(32);
export const OWNERSHIP_SECRET = 'test-ownership-secret-0123456789abcdef';

export interface TestEnv {
  cf: FakeCloudflare;
  namecom: FakeNameCom;
  dns: FakeDns;
  /** HTTPS responses by hostname; missing hostnames fail like a TLS/connection error. */
  sites: Map<string, () => Response>;
  fetch: typeof fetch;
  requests: string[];
  client(overrides?: Partial<DomainwrightConfig>): Domainwright;
}

export function createTestEnv(): TestEnv {
  const cf = new FakeCloudflare(ACCOUNT_ID);
  const namecom = new FakeNameCom();
  const dns = new FakeDns();
  const sites = new Map<string, () => Response>();
  const requests: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.host}${url.pathname}`);
    if (url.host === 'api.cloudflare.com') return cf.handle(request);
    if (url.host === 'api.dev.name.com' || url.host === 'api.name.com') return namecom.handle(request);
    if (url.host === 'cloudflare-dns.com') return dns.handle(url);
    const site = sites.get(url.host);
    if (site) return site();
    throw new TypeError(`fetch failed: ${url.host}`);
  }) as typeof fetch;

  return {
    cf,
    namecom,
    dns,
    sites,
    fetch: fetchImpl,
    requests,
    client(overrides = {}) {
      return new Domainwright({
        cloudflare: { apiToken: cf.token, accountId: ACCOUNT_ID },
        registrar: { provider: 'namecom', username: namecom.username, apiToken: namecom.token, environment: 'sandbox' },
        ownership: { secret: OWNERSHIP_SECRET },
        http: { fetch: fetchImpl, retry: { initialDelayMs: 1, maxDelayMs: 5, jitter: false } },
        ...overrides,
      });
    },
  };
}
