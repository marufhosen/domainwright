/** In-memory fake of the name.com Core API endpoints Domainwright uses. */

export interface FakeNameComDomain {
  domainName: string;
  createDate: string;
  expireDate: string;
  autorenewEnabled: boolean;
  locked: boolean;
  privacyEnabled: boolean;
  nameservers: string[];
  renewalPrice: number;
}

export class FakeNameCom {
  username = 'platform-test';
  token = 'namecom-sandbox-token';
  /** Domains already registered by someone (not purchasable). */
  taken = new Set<string>(['taken.com']);
  premium = new Map<string, number>([['gold.com', 2500]]);
  basePrice = 12.99;
  owned = new Map<string, FakeNameComDomain>();
  orders = 0;
  idempotency = new Map<string, unknown>();
  calls: { method: string; path: string; body?: unknown; headers: Record<string, string> }[] = [];
  /** Fail the next create request this way. */
  nextCreate: 'network' | 'payment' | 'server-error-after-processing' | null = null;

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const method = request.method;
    const body = request.body ? ((await request.json()) as Record<string, unknown>) : undefined;
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      if (k !== 'authorization') headers[k] = v;
    });
    this.calls.push({ method, path, ...(body ? { body } : {}), headers });

    const expected = `Basic ${btoa(`${this.username}:${this.token}`)}`;
    if (request.headers.get('authorization') !== expected)
      return Response.json({ message: 'Unauthorized' }, { status: 401 });

    let m: RegExpExecArray | null;
    if (path === '/core/v1/domains:checkAvailability' && method === 'POST') {
      const names = (body?.domainNames as string[]) ?? [];
      return Response.json({ results: names.map((n) => this.result(n)) });
    }
    if (path === '/core/v1/domains:search' && method === 'POST') {
      const keyword = String(body?.keyword);
      const tlds = (body?.tldFilter as string[] | undefined) ?? ['com', 'net'];
      const names = tlds.flatMap((t) => [`${keyword}.${t}`, `get${keyword}.${t}`]);
      return Response.json({ results: names.map((n) => this.result(n)) });
    }
    if ((m = /^\/core\/v1\/domains\/([^/:]+):getPricing$/.exec(path)) && method === 'GET') {
      const name = m[1]!;
      const years = Number(url.searchParams.get('years') ?? 1);
      const unit = this.premium.get(name) ?? this.basePrice;
      return Response.json({
        premium: this.premium.has(name),
        purchasePrice: unit * years,
        renewalPrice: unit * years,
        transferPrice: unit,
      });
    }
    if (path === '/core/v1/domains' && method === 'POST') {
      const key = request.headers.get('x-idempotency-key');
      if (key && this.idempotency.has(key)) {
        return Response.json(this.idempotency.get(key), { headers: { 'x-idempotent-replay': '1' } });
      }
      const domain = body?.domain as { domainName: string; nameservers?: string[] };
      const name = domain.domainName;
      if (this.nextCreate === 'network') {
        this.nextCreate = null;
        throw new TypeError('fetch failed');
      }
      if (this.nextCreate === 'payment') {
        this.nextCreate = null;
        return Response.json({ message: 'Payment failed', details: 'card declined' }, { status: 402 });
      }
      if (this.taken.has(name) || this.owned.has(name))
        return Response.json({ message: 'Domain is not available' }, { status: 400 });
      if (this.premium.has(name) && body?.purchasePrice !== this.premium.get(name)! * Number(body?.years ?? 1)) {
        return Response.json({ message: 'Purchase price does not match' }, { status: 400 });
      }
      const created: FakeNameComDomain = {
        domainName: name,
        createDate: '2026-10-19T00:00:00Z',
        expireDate: `${2026 + Number(body?.years ?? 1)}-10-19T00:00:00Z`,
        autorenewEnabled: false,
        locked: true,
        privacyEnabled: true,
        nameservers: domain.nameservers ?? ['ns1.name.com', 'ns2.name.com'],
        renewalPrice: this.basePrice,
      };
      this.owned.set(name, created);
      this.orders += 1;
      const response = {
        domain: created,
        order: 1000 + this.orders,
        totalPaid: this.basePrice * Number(body?.years ?? 1),
      };
      if (key) this.idempotency.set(key, response);
      if (this.nextCreate === 'server-error-after-processing') {
        this.nextCreate = null;
        return Response.json({ message: 'Gateway Timeout' }, { status: 504 });
      }
      return Response.json(response);
    }
    if ((m = /^\/core\/v1\/domains\/([^/:]+):setNameservers$/.exec(path)) && method === 'POST') {
      const d = this.owned.get(m[1]!);
      if (!d) return Response.json({ message: 'Not Found' }, { status: 404 });
      d.nameservers = body?.nameservers as string[];
      return Response.json(d);
    }
    if ((m = /^\/core\/v1\/domains\/([^/:]+):renew$/.exec(path)) && method === 'POST') {
      const d = this.owned.get(m[1]!);
      if (!d) return Response.json({ message: 'Not Found' }, { status: 404 });
      this.orders += 1;
      return Response.json({ domain: d, order: 1000 + this.orders, totalPaid: this.basePrice });
    }
    if ((m = /^\/core\/v1\/domains\/([^/:]+)$/.exec(path)) && method === 'GET') {
      const d = this.owned.get(m[1]!);
      return d ? Response.json(d) : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    return Response.json({ message: `No route ${method} ${path}` }, { status: 404 });
  }

  private result(name: string): Record<string, unknown> {
    const [sld, ...rest] = name.split('.');
    const tld = rest.join('.');
    if (tld === 'maint') return { domainName: name, sld, tld, purchasable: false, reason: 'Registry maintenance' };
    if (this.taken.has(name) || this.owned.has(name)) return { domainName: name, sld, tld, purchasable: false };
    const premium = this.premium.get(name);
    return {
      domainName: name,
      sld,
      tld,
      purchasable: true,
      premium: premium !== undefined,
      purchasePrice: premium ?? this.basePrice,
      purchaseType: 'registration',
      renewalPrice: premium ?? this.basePrice,
    };
  }
}
