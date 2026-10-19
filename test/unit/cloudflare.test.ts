import { describe, expect, it } from 'vitest';
import { ConfirmationRequiredError, TenantConflictError, isDomainwrightError } from '../../src/index.js';
import { createTestEnv } from '../fakes/env.js';

describe('cloudflare.zones', () => {
  it('creates a zone and returns nameservers with delegation instructions', async () => {
    const env = createTestEnv();
    const zone = await env.client().cloudflare.zones.create({ domain: 'MyPropertyApp.com' });
    expect(zone.created).toBe(true);
    expect(zone.id).toMatch(/^[a-f0-9]{32}$/);
    expect(zone.status).toBe('pending');
    expect(zone.nameservers).toEqual(['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']);
    expect(zone.nameserverInstructions?.instructions).toContain('ada.ns.cloudflare.com');
    expect(env.cf.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'mypropertyapp.com',
      account: { id: env.cf.accountId },
      type: 'full',
    });
  });

  it('reuses an existing zone instead of creating a duplicate', async () => {
    const env = createTestEnv();
    env.cf.addZone('example.com', 'active');
    const zone = await env.client().cloudflare.zones.create({ domain: 'example.com' });
    expect(zone.created).toBe(false);
    expect(zone.nameserverInstructions).toBeUndefined();
    expect(env.cf.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(env.cf.zones).toHaveLength(1);
  });

  it('recovers from a creation race by looking the zone up again', async () => {
    const env = createTestEnv();
    const client = env.client();
    const original = env.cf.handle.bind(env.cf);
    // Another process creates the zone between our lookup and our create call.
    env.cf.handle = async (request: Request) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/zones'))
        env.cf.addZone('race.com', 'pending');
      return original(request);
    };
    const zone = await client.cloudflare.zones.create({ domain: 'race.com' });
    expect(zone.created).toBe(false);
    expect(env.cf.zones).toHaveLength(1);
  });

  it('finds the zone containing a hostname', async () => {
    const env = createTestEnv();
    env.cf.addZone('example.com');
    const zone = await env.client().cloudflare.zones.findForHostname('a.b.example.com');
    expect(zone?.name).toBe('example.com');
  });

  it('requires confirmation to delete a zone', async () => {
    const env = createTestEnv();
    const z = env.cf.addZone('example.com');
    const client = env.client();
    await expect(client.cloudflare.zones.delete({ zoneId: z.id, confirm: false })).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    await client.cloudflare.zones.delete({ zoneId: z.id, confirm: true });
    expect(env.cf.zones).toHaveLength(0);
  });

  it('maps permission errors', async () => {
    const env = createTestEnv();
    env.cf.inject({
      path: /^\/zones$/,
      status: 403,
      errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
    });
    const error = await env
      .client()
      .cloudflare.zones.find('example.com')
      .catch((e: unknown) => e);
    expect(isDomainwrightError(error, 'PERMISSION_DENIED')).toBe(true);
  });

  it('retries rate-limited reads', async () => {
    const env = createTestEnv();
    env.cf.addZone('example.com');
    env.cf.inject({
      path: /^\/zones$/,
      status: 429,
      errors: [{ code: 971, message: 'rate limited' }],
      headers: { 'retry-after': '0' },
    });
    const zone = await env.client().cloudflare.zones.find('example.com');
    expect(zone?.name).toBe('example.com');
  });
});

describe('cloudflare.dns', () => {
  it('creates validated, managed records and reuses duplicates', async () => {
    const env = createTestEnv();
    env.cf.addZone('example.com');
    const client = env.client();
    const record = await client.cloudflare.dns.create({
      domain: 'example.com',
      type: 'CNAME',
      name: 'www',
      content: 'my-worker.example.workers.dev',
      proxied: true,
    });
    expect(record).toMatchObject({ created: true, name: 'www.example.com', proxied: true, managed: true });
    const again = await client.cloudflare.dns.create({
      domain: 'example.com',
      type: 'CNAME',
      name: 'www',
      content: 'my-worker.example.workers.dev',
      proxied: true,
    });
    expect(again.created).toBe(false);
    expect(again.id).toBe(record.id);
    expect(env.cf.records).toHaveLength(1);
    await expect(
      client.cloudflare.dns.create({
        domain: 'example.com',
        type: 'CNAME',
        name: 'www',
        content: 'my-worker.example.workers.dev',
        onDuplicate: 'error',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('detects CNAME conflicts before calling the API', async () => {
    const env = createTestEnv();
    env.cf.addZone('example.com');
    env.cf.addRecord('example.com', { name: 'www.example.com', type: 'A', content: '192.0.2.1' });
    const error = await env
      .client()
      .cloudflare.dns.create({ domain: 'example.com', type: 'CNAME', name: 'www', content: 'target.example.net' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as { details: { conflicts: unknown[] } }).details.conflicts).toHaveLength(1);
    expect(env.cf.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('supports TXT verification records and MX priority', async () => {
    const env = createTestEnv();
    env.cf.addZone('example.com');
    const client = env.client();
    const txt = await client.cloudflare.dns.create({
      domain: 'example.com',
      type: 'TXT',
      name: '_verify',
      content: 'verification-token',
    });
    expect(txt.name).toBe('_verify.example.com');
    const mx = await client.cloudflare.dns.create({
      domain: 'example.com',
      type: 'MX',
      name: '@',
      content: 'mx.example.net',
      priority: 10,
      ttl: 3600,
    });
    expect(mx.priority).toBe(10);
    const listed = await client.cloudflare.dns.list({ domain: 'example.com', type: 'TXT' });
    expect(listed.map((r) => r.content)).toEqual(['verification-token']);
  });

  it('refuses to modify or delete unmanaged records without explicit permission', async () => {
    const env = createTestEnv();
    env.cf.addZone('example.com');
    const existing = env.cf.addRecord('example.com', { name: 'example.com', type: 'A', content: '192.0.2.1' });
    const client = env.client();
    await expect(
      client.cloudflare.dns.update({ domain: 'example.com', recordId: existing.id, changes: { content: '192.0.2.2' } }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
    await expect(
      client.cloudflare.dns.delete({ domain: 'example.com', recordId: existing.id, confirm: true }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
    await expect(
      client.cloudflare.dns.delete({
        domain: 'example.com',
        recordId: existing.id,
        confirm: false,
        allowUnmanaged: true,
      }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
    await client.cloudflare.dns.delete({
      domain: 'example.com',
      recordId: existing.id,
      confirm: true,
      allowUnmanaged: true,
    });
    expect(env.cf.records).toHaveLength(0);
  });

  it('updates managed records and keeps the marker', async () => {
    const env = createTestEnv();
    env.cf.addZone('example.com');
    const client = env.client();
    const r = await client.cloudflare.dns.create({
      domain: 'example.com',
      type: 'A',
      name: 'app',
      content: '192.0.2.1',
      comment: 'app server',
      tenantTag: 'abc',
    });
    const updated = await client.cloudflare.dns.update({
      domain: 'example.com',
      recordId: r.id,
      changes: { content: '192.0.2.2' },
    });
    expect(updated.content).toBe('192.0.2.2');
    expect(updated.comment).toBe('app server [domainwright t=abc]');
    expect(updated.tenantTag).toBe('abc');
  });
});

describe('cloudflare.workers', () => {
  it('attaches custom domains idempotently and blocks silent reassignment', async () => {
    const env = createTestEnv();
    const zone = env.cf.addZone('example.com');
    const domains = env.client().cloudflare.workers.customDomains;
    const first = await domains.attach({ hostname: 'example.com', service: 'tenant-a-app', zoneId: zone.id });
    expect(first.created).toBe(true);
    const again = await domains.attach({ hostname: 'example.com', service: 'tenant-a-app', zoneId: zone.id });
    expect(again.created).toBe(false);
    await expect(
      domains.attach({ hostname: 'example.com', service: 'tenant-b-app', zoneId: zone.id }),
    ).rejects.toBeInstanceOf(TenantConflictError);
    const moved = await domains.attach({
      hostname: 'example.com',
      service: 'tenant-b-app',
      zoneId: zone.id,
      allowReassign: true,
    });
    expect(moved.service).toBe('tenant-b-app');
    await expect(domains.detach({ domainId: moved.id, confirm: false })).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
  });

  it('creates routes idempotently and blocks re-pointing', async () => {
    const env = createTestEnv();
    const zone = env.cf.addZone('example.com');
    const routes = env.client().cloudflare.workers.routes;
    const r = await routes.create({ zoneId: zone.id, pattern: 'example.com/*', script: 'app' });
    expect(r.created).toBe(true);
    expect((await routes.create({ zoneId: zone.id, pattern: 'example.com/*', script: 'app' })).created).toBe(false);
    await expect(routes.create({ zoneId: zone.id, pattern: 'example.com/*', script: 'other' })).rejects.toBeInstanceOf(
      TenantConflictError,
    );
  });

  it('reports certificate status for a hostname', async () => {
    const env = createTestEnv();
    const zone = env.cf.addZone('example.com');
    const certs = env.client().cloudflare.certificates;
    expect((await certs.statusFor(zone.id, 'www.example.com')).readiness).toBe('active');
    expect((await certs.statusFor(zone.id, 'a.b.example.com')).readiness).toBe('missing');
  });
});
