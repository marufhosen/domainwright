import { describe, expect, it } from 'vitest';
import type {
  RegisteredDomain,
  RegistrarAdapter,
  SetupCustomDomainInput,
  SetupWorkflowState,
} from '../../src/index.js';
import { createTestEnv, type TestEnv } from '../fakes/env.js';

const mutating = (env: TestEnv): string[] =>
  env.requests.filter(
    (r) => /^(POST|PUT|PATCH|DELETE) /.test(r) && !r.includes(':checkAvailability') && !r.includes(':search'),
  );

function stepStatus(result: { steps: { id: string; status: string }[] }): Record<string, string> {
  return Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
}

/** Simulate the tenant changing nameservers and Cloudflare activating the zone. */
async function delegate(env: TestEnv, domain: string, tenantId?: string): Promise<void> {
  env.cf.activate(domain);
  env.dns.set(domain, 'NS', ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']);
  env.dns.set(domain, 'A', ['104.21.0.1']);
  env.dns.set(`www.${domain}`, 'A', ['104.21.0.1']);
  if (tenantId) {
    const challenge = await env.client().ownership.createChallenge({ hostname: domain, tenantId });
    env.dns.set(challenge.record.name, 'TXT', [challenge.record.content]);
  }
  env.sites.set(domain, () => new Response('ok'));
  env.sites.set(`www.${domain}`, () => new Response('ok'));
}

const base: SetupCustomDomainInput = {
  domain: 'marketplace-a.com',
  tenantId: 'tenant-a',
  worker: { name: 'property-source', environment: 'production' },
  dns: { root: true, www: true },
};

describe('setupCustomDomain: externally registered domain with Workers Custom Domains', () => {
  it('configures everything it can, reports outstanding nameserver work, then resumes to active', async () => {
    const env = createTestEnv();
    const client = env.client();
    const checkpoints: SetupWorkflowState[] = [];
    const first = await client.workflows.setupCustomDomain({ ...base, onCheckpoint: (s) => void checkpoints.push(s) });

    expect(stepStatus(first)).toEqual({
      validate: 'succeeded',
      registration: 'skipped',
      zone: 'succeeded',
      ownership: 'succeeded',
      nameservers: 'waiting',
      dns: 'succeeded',
      routing: 'succeeded',
      verification: 'waiting',
    });
    expect(first.lifecycle).toBe('verifying');
    expect(first.ready).toBe(false);
    expect(first.outstandingActions).toContainEqual(
      expect.objectContaining({
        type: 'update-nameservers',
        nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
        automatable: false,
      }),
    );
    expect(env.cf.customDomains.map((d) => [d.hostname, d.service])).toEqual([
      ['marketplace-a.com', 'property-source-production'],
      ['www.marketplace-a.com', 'property-source-production'],
    ]);
    expect(checkpoints.length).toBeGreaterThanOrEqual(8);
    expect(JSON.parse(JSON.stringify(first.state))).toEqual(first.state);

    await delegate(env, 'marketplace-a.com', 'tenant-a');
    const writesBefore = mutating(env).length;
    const second = await client.workflows.setupCustomDomain({ ...base, resumeFrom: first.state });

    expect(second.lifecycle).toBe('active');
    expect(second.ready).toBe(true);
    expect(second.verification?.verified).toBe(true);
    expect(mutating(env).length).toBe(writesBefore); // nothing re-created
    expect(env.cf.zones).toHaveLength(1);
    expect(env.cf.customDomains).toHaveLength(2);
    expect(env.cf.records.filter((r) => r.type === 'TXT')).toHaveLength(1);
  });

  it('updates nameservers at the registrar only when authorized', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.domains.purchase({ domain: 'owned.com', maxPrice: 15 });

    const unauthorized = await client.workflows.setupCustomDomain({ ...base, domain: 'owned.com' });
    expect(unauthorized.outstandingActions).toContainEqual(
      expect.objectContaining({ type: 'update-nameservers', automatable: true }),
    );
    expect(env.namecom.owned.get('owned.com')?.nameservers).toEqual(['ns1.name.com', 'ns2.name.com']);

    const authorized = await client.workflows.setupCustomDomain({
      ...base,
      domain: 'owned.com',
      nameservers: { updateAtRegistrar: true },
      resumeFrom: unauthorized.state,
    });
    expect(stepStatus(authorized).nameservers).toBe('waiting');
    expect(env.namecom.owned.get('owned.com')?.nameservers).toEqual(['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']);
    expect(env.cf.calls.some((c) => c.path.endsWith('/activation_check'))).toBe(true);
  });
});

describe('setupCustomDomain: purchase', () => {
  const purchase: SetupCustomDomainInput = {
    ...base,
    domain: 'mypropertyapp.com',
    registration: { purchase: true, years: 1, maxPrice: 15 },
    nameservers: { updateAtRegistrar: true },
  };

  it('purchases once, creates the zone and delegates it', async () => {
    const env = createTestEnv();
    const result = await env.client().workflows.setupCustomDomain(purchase);
    expect(stepStatus(result).registration).toBe('succeeded');
    expect(result.state.resources.registration).toMatchObject({ status: 'registered', orderId: '1001' });
    expect(env.namecom.orders).toBe(1);
    expect(env.namecom.owned.get('mypropertyapp.com')?.nameservers).toEqual([
      'ada.ns.cloudflare.com',
      'bob.ns.cloudflare.com',
    ]);

    const resumed = await env.client().workflows.setupCustomDomain({ ...purchase, resumeFrom: result.state });
    expect(env.namecom.orders).toBe(1);
    expect(stepStatus(resumed).registration).toBe('succeeded');
  });

  it('never purchases twice when the first outcome was unknown', async () => {
    const env = createTestEnv();
    const states: SetupWorkflowState[] = [];
    env.namecom.nextCreate = 'server-error-after-processing';
    const first = await env
      .client()
      .workflows.setupCustomDomain({ ...purchase, onCheckpoint: (s) => void states.push(s) });
    expect(stepStatus(first).registration).toBe('failed');
    expect(first.errors[0]).toMatchObject({ step: 'registration', code: 'PURCHASE_OUTCOME_UNKNOWN' });
    expect(first.lifecycle).toBe('registering');
    // The idempotency key was persisted before the request was sent.
    expect(states.some((s) => s.resources.registration?.status === 'submitting')).toBe(true);
    expect(stepStatus(first).zone).toBe('pending');

    const resumed = await env.client().workflows.setupCustomDomain({ ...purchase, resumeFrom: first.state });
    expect(stepStatus(resumed).registration).toBe('succeeded');
    expect(env.namecom.orders).toBe(1);
    expect(env.namecom.calls.filter((c) => c.method === 'POST' && c.path === '/core/v1/domains')).toHaveLength(1);
  });

  it('does not purchase if the checkpoint cannot be persisted', async () => {
    const env = createTestEnv();
    const result = await env.client().workflows.setupCustomDomain({
      ...purchase,
      onCheckpoint: (s) => {
        if (s.resources.registration?.status === 'submitting') throw new Error('database down');
      },
    });
    expect(stepStatus(result).registration).toBe('failed');
    expect(env.namecom.orders).toBe(0);
    expect(result.state.resources.registration).toBeUndefined();
  });

  it('keeps the previous idempotency key when the checkpoint fails on resume (#1)', async () => {
    const env = createTestEnv();
    env.namecom.nextCreate = 'network';
    const first = await env.client().workflows.setupCustomDomain(purchase);
    expect(first.state.resources.registration).toMatchObject({ status: 'unknown' });
    const originalKey = first.state.resources.registration!.idempotencyKey;

    // Resume, but the pre-purchase checkpoint fails once.
    let failed = false;
    let persisted: SetupWorkflowState | undefined;
    const second = await env.client().workflows.setupCustomDomain({
      ...purchase,
      resumeFrom: first.state,
      onCheckpoint: (s) => {
        if (!failed && s.resources.registration?.status === 'submitting') {
          failed = true;
          throw new Error('database down');
        }
        persisted = s;
      },
    });
    expect(stepStatus(second).registration).toBe('failed');
    expect(persisted?.resources.registration).toMatchObject({ status: 'unknown', idempotencyKey: originalKey });
    expect(second.state.resources.registration?.idempotencyKey).toBe(originalKey);

    // The next resume repeats the purchase with the original key only.
    await env.client().workflows.setupCustomDomain({ ...purchase, resumeFrom: persisted! });
    const keys = env.namecom.calls
      .filter((c) => c.method === 'POST' && c.path === '/core/v1/domains')
      .map((c) => c.headers['x-idempotency-key']);
    expect(new Set(keys)).toEqual(new Set([originalKey]));
    expect(env.namecom.orders).toBe(1);
  });

  it('stops on a payment failure without touching Cloudflare', async () => {
    const env = createTestEnv();
    env.namecom.nextCreate = 'payment';
    const result = await env.client().workflows.setupCustomDomain(purchase);
    expect(result.errors[0]).toMatchObject({ code: 'PAYMENT_FAILED' });
    expect(result.lifecycle).toBe('failed');
    expect(env.cf.zones).toHaveLength(0);
  });

  it('records pending registrations as pending and never resubmits them (#2)', async () => {
    const env = createTestEnv();
    let registerCalls = 0;
    let registered: RegisteredDomain | null = null;
    let nextStatus: 'pending' | 'action-required' = 'pending';
    const adapter: RegistrarAdapter = {
      id: 'slow',
      displayName: 'Slow Registrar',
      capabilities: {
        checkAvailability: true,
        suggestions: false,
        pricing: true,
        register: true,
        idempotentRegistration: true,
        renew: false,
        getDomain: true,
        setNameservers: false,
      },
      checkAvailability: async (domains) =>
        domains.map((domain) => ({
          domain,
          tld: 'com',
          availability: 'available',
          confirmed: true,
          premium: false,
          registrar: 'slow',
        })),
      getPricing: async (domain, years) => ({
        domain,
        years,
        premium: false,
        registrationPrice: { amount: 10, currency: 'USD' },
        renewalPrice: null,
        transferPrice: null,
      }),
      register: async (request) => {
        registerCalls += 1;
        return { domain: request.domain, status: nextStatus, replayed: false, registrar: 'slow' };
      },
      getDomain: async () => registered,
    };
    const client = env.client({ registrar: adapter });
    const input: SetupCustomDomainInput = {
      domain: 'slow-registry.com',
      worker: { name: 'app' },
      registration: { purchase: true, maxPrice: 15 },
    };

    const first = await client.workflows.setupCustomDomain(input);
    expect(stepStatus(first).registration).toBe('waiting');
    expect(first.state.resources.registration?.status).toBe('pending');
    expect(first.lifecycle).toBe('registering');

    // Still pending at the registrar: waiting again, no second order.
    const second = await client.workflows.setupCustomDomain({ ...input, resumeFrom: first.state });
    expect(stepStatus(second).registration).toBe('waiting');
    expect(second.state.resources.registration?.status).toBe('pending');
    expect(registerCalls).toBe(1);

    // Completed at the registrar: the resumed step succeeds without ordering again.
    registered = {
      domain: 'slow-registry.com',
      registrar: 'slow',
      createdAt: null,
      expiresAt: '2027-10-19T00:00:00Z',
      autoRenew: null,
      locked: null,
      privacy: null,
      nameservers: [],
    };
    const third = await client.workflows.setupCustomDomain({ ...input, resumeFrom: second.state });
    expect(stepStatus(third).registration).toBe('succeeded');
    expect(third.state.resources.registration).toMatchObject({
      status: 'registered',
      expiresAt: '2027-10-19T00:00:00Z',
    });
    expect(registerCalls).toBe(1);

    // action-required asks for a manual step instead of waiting silently.
    registered = null;
    nextStatus = 'action-required';
    const other = await client.workflows.setupCustomDomain({ ...input, domain: 'needs-docs.com' });
    expect(other.state.resources.registration?.status).toBe('action-required');
    expect(other.steps.find((s) => s.id === 'registration')?.actions).toEqual([
      expect.objectContaining({ type: 'manual' }),
    ]);
  });
});

describe('setupCustomDomain: tenant isolation', () => {
  it('refuses a domain already claimed by another tenant before changing anything', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.workflows.setupCustomDomain(base);
    const writes = mutating(env).length;

    const takeover = await client.workflows.setupCustomDomain({
      ...base,
      tenantId: 'tenant-b',
      worker: { name: 'tenant-b-app' },
    });
    expect(stepStatus(takeover).ownership).toBe('failed');
    expect(takeover.errors[0]).toMatchObject({ code: 'TENANT_CONFLICT' });
    expect(stepStatus(takeover).routing).toBe('pending');
    expect(mutating(env).length).toBe(writes);
    expect(env.cf.customDomains.every((d) => d.service === 'property-source-production')).toBe(true);
  });

  it('requires adoptExisting for a pre-existing zone without a marker', async () => {
    const env = createTestEnv();
    env.cf.addZone('legacy.com', 'active');
    const client = env.client();
    const refused = await client.workflows.setupCustomDomain({ ...base, domain: 'legacy.com' });
    expect(refused.errors[0]).toMatchObject({ step: 'ownership', code: 'TENANT_CONFLICT' });
    const adopted = await client.workflows.setupCustomDomain({
      ...base,
      domain: 'legacy.com',
      zone: { adoptExisting: true },
    });
    expect(stepStatus(adopted).ownership).toBe('succeeded');
  });

  it('allows reassignment only when explicitly authorized', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.workflows.setupCustomDomain(base);
    const moved = await client.workflows.setupCustomDomain({
      ...base,
      tenantId: 'tenant-b',
      worker: { name: 'tenant-b-app' },
      reassign: { allowed: true },
    });
    expect(stepStatus(moved).ownership).toBe('succeeded');
    expect(stepStatus(moved).routing).toBe('succeeded');
    expect(env.cf.customDomains.every((d) => d.service === 'tenant-b-app')).toBe(true);
  });

  it('rejects resume state from a different tenant', async () => {
    const env = createTestEnv();
    const client = env.client();
    const first = await client.workflows.setupCustomDomain(base);
    await expect(
      client.workflows.setupCustomDomain({ ...base, tenantId: 'tenant-b', resumeFrom: first.state }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_STATE_MISMATCH',
    });
  });
});

describe('setupCustomDomain: dry run', () => {
  it('plans changes without making any', async () => {
    const env = createTestEnv();
    const result = await env
      .client()
      .workflows.setupCustomDomain({ ...base, registration: { purchase: true, maxPrice: 15 }, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(mutating(env)).toEqual([]);
    expect(stepStatus(result)).toMatchObject({
      registration: 'planned',
      zone: 'planned',
      routing: 'planned',
      verification: 'planned',
    });
    expect(result.steps.find((s) => s.id === 'zone')?.planned).toEqual([
      { operation: 'cloudflare.zones.create', target: 'marketplace-a.com' },
    ]);
    expect(result.lifecycle).toBe('pending');
  });
});

describe('setupCustomDomain: Workers Routes', () => {
  it('creates an originless proxied record and a route per hostname', async () => {
    const env = createTestEnv();
    env.cf.addZone('routes.com', 'active');
    const result = await env.client().workflows.setupCustomDomain({
      domain: 'routes.com',
      worker: { name: 'app' },
      routing: { strategy: 'route' },
      dns: { root: true, www: true },
      verification: { https: false },
    });
    expect(stepStatus(result)).toMatchObject({ dns: 'succeeded', routing: 'succeeded' });
    expect(env.cf.records.map((r) => [r.name, r.type, r.content, r.proxied])).toEqual([
      ['routes.com', 'AAAA', '100::', true],
      ['www.routes.com', 'AAAA', '100::', true],
    ]);
    expect(env.cf.routes.map((r) => [r.pattern, r.script])).toEqual([
      ['routes.com/*', 'app'],
      ['www.routes.com/*', 'app'],
    ]);
  });

  it('reports partial completion when an unmanaged record conflicts', async () => {
    const env = createTestEnv();
    env.cf.addZone('conflict.com', 'active');
    env.cf.addRecord('conflict.com', { name: 'www.conflict.com', type: 'A', content: '192.0.2.10' });
    const result = await env.client().workflows.setupCustomDomain({
      domain: 'conflict.com',
      worker: { name: 'app' },
      routing: { strategy: 'route' },
      dns: { root: true, www: true },
    });
    expect(stepStatus(result)).toMatchObject({
      zone: 'succeeded',
      dns: 'failed',
      routing: 'pending',
      verification: 'pending',
    });
    expect(result.lifecycle).toBe('failed');
    expect(result.outstandingActions).toContainEqual(
      expect.objectContaining({ type: 'resolve-dns-conflict', hostname: 'www.conflict.com' }),
    );
    // The unmanaged record was not touched.
    expect(env.cf.records.find((r) => r.name === 'www.conflict.com')?.content).toBe('192.0.2.10');
  });

  it('recovers from a transient provider failure on resume without duplicates', async () => {
    const env = createTestEnv();
    env.cf.addZone('flaky.com', 'active');
    const input: SetupCustomDomainInput = {
      domain: 'flaky.com',
      worker: { name: 'app' },
      routing: { strategy: 'route' },
      verification: { https: false },
    };
    env.cf.inject({ method: 'POST', path: /workers\/routes$/, status: 503, times: 1 });
    const first = await env.client().workflows.setupCustomDomain(input);
    expect(stepStatus(first).routing).toBe('failed');
    expect(first.errors[0]).toMatchObject({ step: 'routing', retryable: true });
    expect(first.lifecycle).toBe('configuring');

    const second = await env.client().workflows.setupCustomDomain({ ...input, resumeFrom: first.state });
    expect(stepStatus(second).routing).toBe('succeeded');
    expect(env.cf.records).toHaveLength(1);
    expect(env.cf.routes).toHaveLength(1);
  });
});

describe('setupCustomDomain: tenant subdomain of the platform zone', () => {
  it('uses the existing platform zone and never creates or deletes zones', async () => {
    const env = createTestEnv();
    env.cf.addZone('example.com', 'active');
    const result = await env.client().workflows.setupCustomDomain({
      domain: 'tenant-a.example.com',
      tenantId: 'tenant-a',
      zone: { name: 'example.com' },
      worker: { name: 'app' },
      verification: { https: false },
    });
    expect(stepStatus(result)).toMatchObject({
      zone: 'succeeded',
      ownership: 'succeeded',
      nameservers: 'skipped',
      routing: 'succeeded',
    });
    expect(env.cf.zones).toHaveLength(1);
    expect(env.cf.customDomains[0]).toMatchObject({ hostname: 'tenant-a.example.com', service: 'app' });
  });
});

describe('setupCustomDomain: Cloudflare for SaaS custom hostnames', () => {
  it('waits for tenant ownership before creating the custom hostname', async () => {
    const env = createTestEnv();
    const saas = env.cf.addZone('platform.com', 'active');
    env.cf.routes.push({ id: 'f'.repeat(32), zone_id: saas.id, pattern: '*/*', script: 'app' });
    const client = env.client();
    const input: SetupCustomDomainInput = {
      domain: 'shop.tenant.com',
      tenantId: 'tenant-a',
      worker: { name: 'app' },
      routing: { strategy: 'saas-custom-hostname', saasZoneId: saas.id, cnameTarget: 'customers.platform.com' },
    };
    const first = await client.workflows.setupCustomDomain(input);
    expect(stepStatus(first)).toMatchObject({
      zone: 'succeeded',
      ownership: 'waiting',
      nameservers: 'skipped',
      dns: 'waiting',
      routing: 'waiting',
    });
    expect(env.cf.customHostnames).toHaveLength(0);
    const txt = first.outstandingActions.find((a) => a.type === 'add-dns-record' && a.record.type === 'TXT');
    expect(txt).toMatchObject({ owner: 'tenant' });

    const challenge = await client.ownership.createChallenge({ hostname: 'shop.tenant.com', tenantId: 'tenant-a' });
    env.dns.set(challenge.record.name, 'TXT', [challenge.record.content]);
    env.dns.set('shop.tenant.com', 'CNAME', ['customers.platform.com']);
    const second = await client.workflows.setupCustomDomain({ ...input, resumeFrom: first.state });
    expect(stepStatus(second)).toMatchObject({ ownership: 'succeeded', routing: 'succeeded', verification: 'waiting' });
    expect(env.cf.customHostnames).toHaveLength(1);
    expect(second.lifecycle).toBe('verifying');

    const ch = env.cf.customHostnames[0]!;
    ch.status = 'active';
    ch.ssl.status = 'active';
    env.dns.set('shop.tenant.com', 'A', ['104.16.0.1']);
    env.sites.set('shop.tenant.com', () => new Response('ok'));
    const third = await client.workflows.setupCustomDomain({ ...input, resumeFrom: second.state });
    expect(third.lifecycle).toBe('active');
    expect(env.cf.customHostnames).toHaveLength(1);
  });

  it('refuses a hostname whose ownership record belongs to another tenant', async () => {
    const env = createTestEnv();
    const saas = env.cf.addZone('platform.com', 'active');
    const client = env.client();
    const other = await client.ownership.createChallenge({ hostname: 'shop.tenant.com', tenantId: 'tenant-b' });
    env.dns.set(other.record.name, 'TXT', [other.record.content]);
    const result = await client.workflows.setupCustomDomain({
      domain: 'shop.tenant.com',
      tenantId: 'tenant-a',
      worker: { name: 'app' },
      routing: { strategy: 'saas-custom-hostname', saasZoneId: saas.id, cnameTarget: 'customers.platform.com' },
    });
    expect(result.errors[0]).toMatchObject({ step: 'ownership', code: 'TENANT_CONFLICT' });
    expect(env.cf.customHostnames).toHaveLength(0);
  });
});
