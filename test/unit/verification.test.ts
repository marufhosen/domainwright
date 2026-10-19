import { describe, expect, it } from 'vitest';
import type { CheckId, CheckResult } from '../../src/index.js';
import { decodeTxt } from '../../src/verification/resolver.js';
import { createTestEnv } from '../fakes/env.js';

const byId = (checks: CheckResult[], id: string, hostname?: string): CheckResult | undefined =>
  checks.find((c) => c.id === id && (hostname === undefined || c.hostname === hostname));

describe('ownership challenges', () => {
  it('are tenant-bound and deterministic', async () => {
    const env = createTestEnv();
    const ownership = env.client().ownership;
    const a = await ownership.createChallenge({ hostname: 'shop.example', tenantId: 'tenant-a' });
    const a2 = await ownership.createChallenge({ hostname: 'SHOP.example', tenantId: 'tenant-a' });
    const b = await ownership.createChallenge({ hostname: 'shop.example', tenantId: 'tenant-b' });
    expect(a.record).toEqual(a2.record);
    expect(a.record.name).toBe('_domainwright.shop.example');
    expect(a.record.content).not.toEqual(b.record.content);
    expect(await ownership.matches(a.record.content, 'shop.example', 'tenant-a')).toBe(true);
    expect(await ownership.matches(a.record.content, 'shop.example', 'tenant-b')).toBe(false);
  });

  it('verifies via public DNS and detects another tenant’s record', async () => {
    const env = createTestEnv();
    const ownership = env.client().ownership;
    const a = await ownership.createChallenge({ hostname: 'shop.example', tenantId: 'tenant-a' });
    expect((await ownership.verifyChallenge({ hostname: 'shop.example', tenantId: 'tenant-a' })).status).toBe(
      'pending',
    );
    env.dns.set(a.record.name, 'TXT', [a.record.content]);
    expect((await ownership.verifyChallenge({ hostname: 'shop.example', tenantId: 'tenant-a' })).status).toBe('passed');
    const b = await ownership.verifyChallenge({ hostname: 'shop.example', tenantId: 'tenant-b' });
    expect(b).toMatchObject({ status: 'failed', reason: 'other-tenant' });
    env.dns.failing = true;
    expect((await ownership.verifyChallenge({ hostname: 'shop.example', tenantId: 'tenant-a' })).status).toBe('error');
  });

  it('decodes multi-string TXT data', () => {
    expect(decodeTxt('"part one" "part two"')).toBe('part onepart two');
  });
});

describe('domains.verify', () => {
  it('reports each check for a pending zone without claiming readiness', async () => {
    const env = createTestEnv();
    env.cf.addZone('pending.com', 'pending');
    const report = await env.client().domains.verify({ domain: 'pending.com', routing: { strategy: 'custom-domain' } });
    expect(report.verified).toBe(false);
    expect(report.summary).toBe('failed'); // no Worker routing exists yet
    expect(byId(report.checks, 'zone')?.status).toBe('passed');
    expect(byId(report.checks, 'nameservers')?.status).toBe('pending');
    expect(byId(report.checks, 'zone-activation')?.status).toBe('pending');
    expect(byId(report.checks, 'certificate', 'pending.com')?.status).toBe('blocked');
    expect(byId(report.checks, 'https', 'pending.com')?.status).toBe('blocked');
    expect(report.outstandingActions.some((a) => a.type === 'update-nameservers')).toBe(true);
    expect(report.errors.map((e) => e.check)).toContain('routing');
  });

  it('passes only when routing, certificate, DNS and HTTPS all check out', async () => {
    const env = createTestEnv();
    const zone = env.cf.addZone('ready.com', 'active');
    const client = env.client();
    await client.cloudflare.workers.customDomains.attach({ hostname: 'ready.com', service: 'app', zoneId: zone.id });
    let report = await client.domains.verify({ domain: 'ready.com', worker: { name: 'app' } });
    expect(byId(report.checks, 'routing')?.status).toBe('passed');
    expect(byId(report.checks, 'dns-resolution')?.status).toBe('pending');
    expect(report.verified).toBe(false);

    env.dns.set('ready.com', 'A', ['104.21.0.1']);
    report = await client.domains.verify({ domain: 'ready.com', worker: { name: 'app' } });
    expect(byId(report.checks, 'https')?.status).toBe('pending'); // TLS/connection error

    env.sites.set('ready.com', () => new Response('ok', { headers: { 'x-served-by': 'app' } }));
    report = await client.domains.verify({
      domain: 'ready.com',
      worker: { name: 'app' },
      https: { header: { name: 'x-served-by', value: 'app' } },
    });
    expect(report.verified).toBe(true);
    expect(report.summary).toBe('verified');
  });

  it('flags a hostname routed to a different Worker', async () => {
    const env = createTestEnv();
    const zone = env.cf.addZone('other.com', 'active');
    const client = env.client();
    await client.cloudflare.workers.customDomains.attach({
      hostname: 'other.com',
      service: 'tenant-b',
      zoneId: zone.id,
    });
    const report = await client.domains.verify({ domain: 'other.com', worker: { name: 'tenant-a' } });
    expect(byId(report.checks, 'routing')).toMatchObject({ status: 'failed' });
    expect(report.summary).toBe('failed');
  });

  it('reports provider errors as check errors rather than failures', async () => {
    const env = createTestEnv();
    env.cf.addZone('err.com', 'active');
    env.cf.inject({ path: /workers\/domains/, status: 500, times: 10 });
    const report = await env
      .client()
      .domains.verify({ domain: 'err.com', routing: { strategy: 'custom-domain' }, https: false });
    expect(byId(report.checks, 'routing')?.status).toBe('error');
    expect(report.summary).toBe('error');
  });

  it('reports a failed registrar lookup without blocking readiness (#5)', async () => {
    const env = createTestEnv();
    const zone = env.cf.addZone('ready.com', 'active');
    await env
      .client()
      .cloudflare.workers.customDomains.attach({ hostname: 'ready.com', service: 'app', zoneId: zone.id });
    env.dns.set('ready.com', 'A', ['104.21.0.1']);
    env.sites.set('ready.com', () => new Response('ok'));
    // Wrong registrar credentials: every name.com lookup returns 401.
    const client = env.client({
      registrar: { provider: 'namecom', username: 'other-test', apiToken: 'wrong-token', environment: 'sandbox' },
    });

    const report = await client.domains.verify({ domain: 'ready.com', worker: { name: 'app' } });
    expect(byId(report.checks, 'registration')).toMatchObject({ status: 'error', required: false });
    expect(report.errors).toContainEqual(
      expect.objectContaining({
        check: 'registration',
        status: 'error',
        error: expect.objectContaining({ code: 'AUTHENTICATION_FAILED' }),
      }),
    );
    expect(report.verified).toBe(true);
    expect(report.summary).toBe('verified');
  });

  it('still fails an expired registration (#5)', async () => {
    const env = createTestEnv();
    const zone = env.cf.addZone('expired.com', 'active');
    const client = env.client();
    await client.cloudflare.workers.customDomains.attach({ hostname: 'expired.com', service: 'app', zoneId: zone.id });
    env.namecom.owned.set('expired.com', {
      domainName: 'expired.com',
      createDate: '2020-01-01T00:00:00Z',
      expireDate: '2021-01-01T00:00:00Z',
      autorenewEnabled: false,
      locked: true,
      privacyEnabled: true,
      nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
      renewalPrice: 12.99,
    });
    const report = await client.domains.verify({ domain: 'expired.com', https: false });
    expect(byId(report.checks, 'registration')).toMatchObject({ status: 'failed', required: true });
    expect(report.summary).toBe('failed');
  });

  it('polls until ready when waitForReady is set', async () => {
    const env = createTestEnv();
    const zone = env.cf.addZone('poll.com', 'active');
    const client = env.client();
    await client.cloudflare.workers.customDomains.attach({ hostname: 'poll.com', service: 'app', zoneId: zone.id });
    env.sites.set('poll.com', () => new Response('ok'));
    let lookups = 0;
    const original = env.dns.handle.bind(env.dns);
    env.dns.handle = (url: URL) => {
      if (url.searchParams.get('type') === 'A' && ++lookups === 2) env.dns.set('poll.com', 'A', ['104.21.0.1']);
      return original(url);
    };
    const report = await client.domains.verify({
      domain: 'poll.com',
      worker: { name: 'app' },
      waitForReady: true,
      intervalMs: 5,
      timeoutMs: 2_000,
    });
    expect(report.verified).toBe(true);
    expect(report.attempts).toBeGreaterThan(1);
  });

  describe('restricted with `checks` (#3)', () => {
    async function readyDomain() {
      const env = createTestEnv();
      const zone = env.cf.addZone('ready.com', 'active');
      const client = env.client();
      await client.cloudflare.workers.customDomains.attach({ hostname: 'ready.com', service: 'app', zoneId: zone.id });
      env.dns.set('ready.com', 'A', ['104.21.0.1']);
      env.sites.set('ready.com', () => new Response('ok'));
      return { env, client };
    }

    it.each<[CheckId[]]>([[['routing']], [['https']], [['certificate']], [['dns-resolution']], [['routing', 'https']]])(
      'evaluates %j on a ready domain and reports only the requested checks',
      async (checks) => {
        const { client } = await readyDomain();
        const report = await client.domains.verify({ domain: 'ready.com', worker: { name: 'app' }, checks });
        expect(report.verified).toBe(true);
        expect(report.summary).toBe('verified');
        expect(new Set(report.checks.map((c) => c.id))).toEqual(new Set(checks));
        expect(report.checks.every((c) => c.status === 'passed')).toBe(true);
      },
    );

    it('surfaces a failed prerequisite that explains a blocked check', async () => {
      const env = createTestEnv();
      const report = await env.client().domains.verify({ domain: 'missing.com', checks: ['routing'] });
      expect(report.summary).toBe('failed');
      expect(byId(report.checks, 'zone')?.status).toBe('failed');
      expect(byId(report.checks, 'routing')?.status).toBe('blocked');
      expect(report.errors.map((e) => e.check)).toEqual(['zone']);
    });

    it('does not run checks outside the requested set and their prerequisites', async () => {
      const { env, client } = await readyDomain();
      const before = env.requests.length;
      await client.domains.verify({ domain: 'ready.com', checks: ['zone'] });
      const made = env.requests.slice(before);
      expect(made.some((r) => r.includes('ready.com/'))).toBe(false); // no HTTPS probe
      expect(made.some((r) => r.includes('/workers/domains'))).toBe(false); // no routing lookup
    });
  });

  it('times out with the last observed state', async () => {
    const env = createTestEnv();
    env.cf.addZone('slow.com', 'pending');
    const report = await env.client().domains.verify({
      domain: 'slow.com',
      routing: { strategy: 'route' },
      checks: ['zone', 'zone-activation'],
      waitForReady: true,
      intervalMs: 5,
      timeoutMs: 30,
    });
    expect(report.timedOut).toBe(true);
    expect(report.verified).toBe(false);
    expect(report.checks.map((c) => c.id)).toEqual(['zone', 'zone-activation']);
  });
});

describe('SaaS apex hostnames without a visible CNAME (#4)', () => {
  function saasApex() {
    const env = createTestEnv();
    const saas = env.cf.addZone('platform.com', 'active');
    env.cf.routes.push({ id: 'd'.repeat(32), zone_id: saas.id, pattern: '*/*', script: 'app' });
    // Active custom hostname and certificate, e.g. after TXT pre-validation.
    env.cf.customHostnames.push({
      id: 'e'.repeat(32),
      zone_id: saas.id,
      hostname: 'tenant.com',
      status: 'active',
      ssl: { status: 'active', method: 'txt', validation_records: [], validation_errors: [] },
      ownership_verification: { type: 'txt', name: '_cf-custom-hostname.tenant.com', value: 'v' },
    });
    env.dns.set('customers.platform.com', 'A', ['104.16.0.1', '104.16.0.2']);
    env.sites.set('tenant.com', () => new Response('ok'));
    const input = {
      domain: 'tenant.com',
      worker: { name: 'app' },
      routing: {
        strategy: 'saas-custom-hostname' as const,
        saasZoneId: saas.id,
        cnameTarget: 'customers.platform.com',
      },
    };
    return { env, input };
  }

  it('passes when a flattened record resolves to the target addresses', async () => {
    const { env, input } = saasApex();
    env.dns.set('tenant.com', 'A', ['104.16.0.2']); // flattened: no CNAME, the target's address
    const report = await env.client().domains.verify(input);
    expect(byId(report.checks, 'dns-records', 'tenant.com')).toMatchObject({
      status: 'passed',
      details: { flattened: true, addresses: ['104.16.0.2'] },
    });
    expect(report.verified).toBe(true);
  });

  it('stays pending when the hostname still points elsewhere, even if Cloudflare reports it active', async () => {
    const { env, input } = saasApex();
    env.dns.set('tenant.com', 'A', ['203.0.113.10']); // still the tenant's old host
    const report = await env.client().domains.verify(input);
    expect(byId(report.checks, 'dns-records', 'tenant.com')?.status).toBe('pending');
    expect(report.verified).toBe(false);
  });
});
