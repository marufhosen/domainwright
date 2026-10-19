/**
 * In-memory fake of the Cloudflare API v4 endpoints Domainwright uses. It mirrors the
 * documented envelope (`success`, `errors`, `result`, `result_info`) and behaviours that
 * matter for safety tests (duplicate zones, CNAME conflicts, attach upserts).
 */

export interface FakeZone {
  id: string;
  name: string;
  status: 'initializing' | 'pending' | 'active' | 'moved';
  type: 'full' | 'partial';
  name_servers: string[];
  original_name_servers: string[];
  account: { id: string };
  activated_on: string | null;
}

export interface FakeRecord {
  id: string;
  zone_id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
  comment?: string | null;
}

export interface Injection {
  method?: string;
  path: RegExp;
  status: number;
  errors?: { code: number; message: string }[];
  /** Number of times to inject; default 1. */
  times?: number;
  /** Throw a network error instead of responding. */
  network?: boolean;
  headers?: Record<string, string>;
}

let counter = 0;
const id = (): string => (++counter).toString(16).padStart(32, '0');

export class FakeCloudflare {
  readonly accountId: string;
  zones: FakeZone[] = [];
  records: FakeRecord[] = [];
  customDomains: {
    id: string;
    hostname: string;
    service: string;
    zone_id: string;
    zone_name: string;
    cert_id: string;
  }[] = [];
  routes: { id: string; zone_id: string; pattern: string; script?: string }[] = [];
  customHostnames: {
    id: string;
    zone_id: string;
    hostname: string;
    status: string;
    ssl: { status: string; method: string; validation_records: unknown[]; validation_errors: unknown[] };
    ownership_verification: { type: 'txt'; name: string; value: string };
  }[] = [];
  certificatePacks: { id: string; zone_id: string; type: string; hosts: string[]; status: string }[] = [];
  calls: { method: string; path: string; body?: unknown }[] = [];
  injections: Injection[] = [];
  /** Token presented by requests must equal this. */
  token = 'cf-test-token-0123456789abcdef';
  /** When true, attaching a custom domain issues an active certificate immediately. */
  autoIssueCertificates = true;

  constructor(accountId = 'a'.repeat(32)) {
    this.accountId = accountId;
  }

  addZone(name: string, status: FakeZone['status'] = 'active'): FakeZone {
    const zone: FakeZone = {
      id: id(),
      name,
      status,
      type: 'full',
      name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
      original_name_servers: ['ns1.registrar.example', 'ns2.registrar.example'],
      account: { id: this.accountId },
      activated_on: status === 'active' ? '2026-01-01T00:00:00Z' : null,
    };
    this.zones.push(zone);
    if (status === 'active')
      this.certificatePacks.push({
        id: id(),
        zone_id: zone.id,
        type: 'universal',
        hosts: [name, `*.${name}`],
        status: 'active',
      });
    return zone;
  }

  activate(name: string): void {
    const zone = this.zones.find((z) => z.name === name);
    if (!zone) throw new Error(`no zone ${name}`);
    zone.status = 'active';
    zone.activated_on = new Date().toISOString();
    if (!this.certificatePacks.some((p) => p.zone_id === zone.id && p.type === 'universal')) {
      this.certificatePacks.push({
        id: id(),
        zone_id: zone.id,
        type: 'universal',
        hosts: [name, `*.${name}`],
        status: 'active',
      });
    }
  }

  addRecord(
    zoneName: string,
    record: Omit<FakeRecord, 'id' | 'zone_id' | 'ttl' | 'proxied'> & Partial<FakeRecord>,
  ): FakeRecord {
    const zone = this.zones.find((z) => z.name === zoneName)!;
    const full: FakeRecord = { id: id(), zone_id: zone.id, ttl: 1, proxied: false, ...record };
    this.records.push(full);
    return full;
  }

  inject(injection: Injection): void {
    this.injections.push({ times: 1, ...injection });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/client\/v4/, '');
    const method = request.method;
    const body = request.body ? ((await request.json()) as Record<string, unknown>) : undefined;
    this.calls.push({ method, path, ...(body ? { body } : {}) });

    if (request.headers.get('authorization') !== `Bearer ${this.token}`) {
      return this.error(401, [{ code: 10000, message: 'Authentication error' }]);
    }
    const injection = this.injections.find(
      (i) => (!i.method || i.method === method) && i.path.test(path) && (i.times ?? 1) > 0,
    );
    if (injection) {
      injection.times = (injection.times ?? 1) - 1;
      if (injection.network) throw new TypeError('fetch failed');
      return this.error(
        injection.status,
        injection.errors ?? [{ code: 9999, message: 'injected failure' }],
        injection.headers,
      );
    }

    const q = url.searchParams;
    let m: RegExpExecArray | null;

    if (path === '/user/tokens/verify') return this.ok({ id: 'tok', status: 'active' });

    // Zones
    if (path === '/zones' && method === 'GET') {
      const list = this.zones.filter(
        (z) =>
          (!q.get('name') || z.name === q.get('name')) &&
          (!q.get('account.id') || z.account.id === q.get('account.id')),
      );
      return this.page(list, q);
    }
    if (path === '/zones' && method === 'POST') {
      const name = String(body?.name);
      if (this.zones.some((z) => z.name === name))
        return this.error(400, [{ code: 1061, message: `${name} already exists` }]);
      const zone = this.addZone(name, 'pending');
      return this.ok(zone);
    }
    if ((m = /^\/zones\/([a-f0-9]{32})$/.exec(path))) {
      const zone = this.zones.find((z) => z.id === m![1]);
      if (!zone) return this.error(404, [{ code: 1001, message: 'Invalid zone identifier' }]);
      if (method === 'GET') return this.ok(zone);
      if (method === 'DELETE') {
        this.zones = this.zones.filter((z) => z.id !== zone.id);
        this.records = this.records.filter((r) => r.zone_id !== zone.id);
        return this.ok({ id: zone.id });
      }
    }
    if ((m = /^\/zones\/([a-f0-9]{32})\/activation_check$/.exec(path)) && method === 'PUT')
      return this.ok({ id: m[1] });

    // DNS records
    if ((m = /^\/zones\/([a-f0-9]{32})\/dns_records$/.exec(path))) {
      const zoneId = m[1]!;
      if (method === 'GET') {
        const list = this.records.filter(
          (r) =>
            r.zone_id === zoneId &&
            (!q.get('type') || r.type === q.get('type')) &&
            (!q.get('name.exact') || r.name === q.get('name.exact')),
        );
        return this.page(list, q);
      }
      if (method === 'POST') {
        const same = this.records.filter((r) => r.zone_id === zoneId && r.name === body?.name);
        if (same.some((r) => r.type === 'CNAME') || (body?.type === 'CNAME' && same.length)) {
          return this.error(400, [
            { code: 81053, message: 'An A, AAAA, or CNAME record with that host already exists.' },
          ]);
        }
        const record: FakeRecord = {
          id: id(),
          zone_id: zoneId,
          name: String(body?.name),
          type: String(body?.type),
          content: typeof body?.content === 'string' ? body.content : '',
          ttl: Number(body?.ttl ?? 1),
          proxied: Boolean(body?.proxied),
          ...(body?.priority === undefined ? {} : { priority: Number(body.priority) }),
          comment: (body?.comment as string | undefined) ?? null,
        };
        this.records.push(record);
        return this.ok(record);
      }
    }
    if ((m = /^\/zones\/([a-f0-9]{32})\/dns_records\/([a-f0-9]{32})$/.exec(path))) {
      const record = this.records.find((r) => r.zone_id === m![1] && r.id === m![2]);
      if (!record) return this.error(404, [{ code: 81044, message: 'Record does not exist.' }]);
      if (method === 'GET') return this.ok(record);
      if (method === 'PATCH') {
        Object.assign(record, body);
        return this.ok(record);
      }
      if (method === 'DELETE') {
        this.records = this.records.filter((r) => r.id !== record.id);
        return this.ok({ id: record.id });
      }
    }

    // Workers custom domains
    if (path === `/accounts/${this.accountId}/workers/domains`) {
      if (method === 'GET') {
        return this.ok(
          this.customDomains.filter(
            (d) =>
              (!q.get('hostname') || d.hostname === q.get('hostname')) &&
              (!q.get('service') || d.service === q.get('service')),
          ),
        );
      }
      if (method === 'PUT') {
        const hostname = String(body?.hostname);
        const zone = this.zones.find((z) => z.id === body?.zone_id || z.name === body?.zone_name);
        if (!zone) return this.error(400, [{ code: 100100, message: 'zone not found' }]);
        const conflicting = this.records.find(
          (r) => r.zone_id === zone.id && r.name === hostname && ['A', 'AAAA', 'CNAME'].includes(r.type),
        );
        if (conflicting)
          return this.error(409, [{ code: 100117, message: 'Hostname already has externally managed DNS records' }]);
        let domain = this.customDomains.find((d) => d.hostname === hostname);
        if (domain) domain.service = String(body?.service);
        else {
          domain = {
            id: id(),
            hostname,
            service: String(body?.service),
            zone_id: zone.id,
            zone_name: zone.name,
            cert_id: id(),
          };
          this.customDomains.push(domain);
          if (this.autoIssueCertificates)
            this.certificatePacks.push({
              id: id(),
              zone_id: zone.id,
              type: 'advanced',
              hosts: [hostname],
              status: 'active',
            });
          else
            this.certificatePacks.push({
              id: id(),
              zone_id: zone.id,
              type: 'advanced',
              hosts: [hostname],
              status: 'pending_validation',
            });
        }
        return this.ok(domain);
      }
    }
    if ((m = new RegExp(`^/accounts/${this.accountId}/workers/domains/([a-f0-9]{32})$`).exec(path))) {
      const domain = this.customDomains.find((d) => d.id === m![1]);
      if (!domain) return this.error(404, [{ code: 100101, message: 'not found' }]);
      if (method === 'GET') return this.ok(domain);
      if (method === 'DELETE') {
        this.customDomains = this.customDomains.filter((d) => d.id !== domain.id);
        return this.ok(null);
      }
    }

    // Workers routes
    if ((m = /^\/zones\/([a-f0-9]{32})\/workers\/routes$/.exec(path))) {
      const zoneId = m[1]!;
      if (method === 'GET')
        return this.ok(this.routes.filter((r) => r.zone_id === zoneId).map(({ zone_id: _z, ...r }) => r));
      if (method === 'POST') {
        if (this.routes.some((r) => r.zone_id === zoneId && r.pattern === body?.pattern)) {
          return this.error(409, [{ code: 10020, message: 'A route with the same pattern already exists' }]);
        }
        const route = { id: id(), zone_id: zoneId, pattern: String(body?.pattern), script: String(body?.script) };
        this.routes.push(route);
        return this.ok({ id: route.id, pattern: route.pattern, script: route.script });
      }
    }
    if ((m = /^\/zones\/([a-f0-9]{32})\/workers\/routes\/([a-f0-9]{32})$/.exec(path))) {
      const route = this.routes.find((r) => r.id === m![2]);
      if (!route) return this.error(404, [{ code: 10007, message: 'not found' }]);
      if (method === 'PUT') {
        route.script = String(body?.script);
        return this.ok(route);
      }
      if (method === 'DELETE') {
        this.routes = this.routes.filter((r) => r.id !== route.id);
        return this.ok({ id: route.id });
      }
    }

    // Custom hostnames
    if ((m = /^\/zones\/([a-f0-9]{32})\/custom_hostnames$/.exec(path))) {
      const zoneId = m[1]!;
      if (method === 'GET') {
        return this.page(
          this.customHostnames.filter(
            (h) => h.zone_id === zoneId && (!q.get('hostname.exact') || h.hostname === q.get('hostname.exact')),
          ),
          q,
        );
      }
      if (method === 'POST') {
        const hostname = String(body?.hostname);
        const ch = {
          id: id(),
          zone_id: zoneId,
          hostname,
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: (body?.ssl as { method?: string } | undefined)?.method ?? 'http',
            validation_records: [],
            validation_errors: [],
          },
          ownership_verification: {
            type: 'txt' as const,
            name: `_cf-custom-hostname.${hostname}`,
            value: 'cf-ownership-token',
          },
        };
        this.customHostnames.push(ch);
        return this.ok(ch);
      }
    }
    if ((m = /^\/zones\/([a-f0-9]{32})\/custom_hostnames\/([a-f0-9]{32})$/.exec(path))) {
      const ch = this.customHostnames.find((h) => h.id === m![2]);
      if (!ch) return this.error(404, [{ code: 1436, message: 'not found' }]);
      if (method === 'GET') return this.ok(ch);
      if (method === 'DELETE') {
        this.customHostnames = this.customHostnames.filter((h) => h.id !== ch.id);
        return this.ok({ id: ch.id });
      }
    }

    // Certificates
    if ((m = /^\/zones\/([a-f0-9]{32})\/ssl\/certificate_packs$/.exec(path)) && method === 'GET') {
      return this.page(
        this.certificatePacks.filter((p) => p.zone_id === m![1]),
        q,
      );
    }

    return this.error(404, [{ code: 7003, message: `No route for ${method} ${path}` }]);
  }

  private ok(result: unknown): Response {
    return Response.json({ success: true, errors: [], messages: [], result });
  }

  private page<T>(list: T[], q: URLSearchParams): Response {
    const perPage = Number(q.get('per_page') ?? 20);
    const page = Number(q.get('page') ?? 1);
    const slice = list.slice((page - 1) * perPage, page * perPage);
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: slice,
      result_info: {
        page,
        per_page: perPage,
        count: slice.length,
        total_count: list.length,
        total_pages: Math.max(1, Math.ceil(list.length / perPage)),
      },
    });
  }

  private error(
    status: number,
    errors: { code: number; message: string }[],
    headers?: Record<string, string>,
  ): Response {
    return Response.json(
      { success: false, errors, messages: [], result: null },
      { status, ...(headers ? { headers } : {}) },
    );
  }
}
