import { describe, expect, it } from 'vitest';
import { ConfirmationRequiredError } from '../../src/index.js';
import { createTestEnv } from '../fakes/env.js';

describe('removeCustomDomain', () => {
  it('requires confirmation, and previews without changes', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.workflows.setupCustomDomain({
      domain: 'bye.com',
      tenantId: 't1',
      worker: { name: 'app' },
      dns: { www: true },
    });
    await expect(client.workflows.removeCustomDomain({ domain: 'bye.com', tenantId: 't1' })).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    const preview = await client.workflows.removeCustomDomain({
      domain: 'bye.com',
      tenantId: 't1',
      worker: { name: 'app' },
      dns: { www: true },
      dryRun: true,
    });
    expect(preview.lifecycle).toBe('unchanged');
    expect(preview.removed.customDomains).toEqual(['bye.com', 'www.bye.com']);
    expect(env.cf.customDomains).toHaveLength(2);
  });

  it('removes only managed resources for the tenant and keeps everything else', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.workflows.setupCustomDomain({
      domain: 'bye.com',
      tenantId: 't1',
      worker: { name: 'app' },
      dns: { www: true },
      verification: { https: false },
    });
    env.cf.addRecord('bye.com', { name: 'bye.com', type: 'MX', content: 'mx.mail.example', priority: 10 });
    const result = await client.workflows.removeCustomDomain({
      domain: 'bye.com',
      tenantId: 't1',
      worker: { name: 'app' },
      dns: { www: true },
      deleteZone: true,
      confirm: true,
    });
    expect(result.lifecycle).toBe('disabled');
    expect(result.removed.customDomains).toEqual(['bye.com', 'www.bye.com']);
    expect(result.removed.dnsRecords).toEqual(['TXT _domainwright.bye.com']);
    expect(result.removed.zone).toBeNull();
    expect(result.retained).toContainEqual(
      expect.objectContaining({ resource: 'dns:MX bye.com', reason: 'not created by Domainwright' }),
    );
    expect(env.cf.customDomains).toHaveLength(0);
    expect(env.cf.zones).toHaveLength(1);
  });

  it('deletes the zone when explicitly requested and only managed records remain', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.workflows.setupCustomDomain({
      domain: 'gone.com',
      tenantId: 't1',
      worker: { name: 'app' },
      routing: { strategy: 'route' },
      verification: { https: false },
    });
    const result = await client.workflows.removeCustomDomain({
      domain: 'gone.com',
      tenantId: 't1',
      worker: { name: 'app' },
      routing: { strategy: 'route' },
      deleteZone: true,
      confirm: true,
    });
    expect(result.removed.routes).toEqual(['gone.com/*']);
    expect(result.removed.zone).toBe('gone.com');
    expect(env.cf.zones).toHaveLength(0);
  });

  it('refuses to remove a domain owned by another tenant', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.workflows.setupCustomDomain({ domain: 'mine.com', tenantId: 't1', worker: { name: 'app' } });
    const result = await client.workflows.removeCustomDomain({ domain: 'mine.com', tenantId: 't2', confirm: true });
    expect(result.lifecycle).toBe('failed');
    expect(result.errors[0]).toMatchObject({ step: 'tenant', code: 'TENANT_CONFLICT' });
    expect(env.cf.customDomains).toHaveLength(1);
  });

  it('leaves routing that belongs to a different Worker', async () => {
    const env = createTestEnv();
    const zone = env.cf.addZone('shared.com', 'active');
    const client = env.client();
    await client.cloudflare.workers.customDomains.attach({
      hostname: 'shared.com',
      service: 'other-app',
      zoneId: zone.id,
    });
    const result = await client.workflows.removeCustomDomain({
      domain: 'shared.com',
      worker: { name: 'app' },
      confirm: true,
    });
    expect(result.retained).toContainEqual(expect.objectContaining({ resource: 'custom-domain:shared.com' }));
    expect(env.cf.customDomains).toHaveLength(1);
  });
});

describe('removeCustomDomain: SaaS custom hostnames (#6)', () => {
  async function saasEnv() {
    const env = createTestEnv();
    const client = env.client();
    const saas = env.cf.addZone('platform.com', 'active');
    env.cf.customHostnames.push({
      id: 'f'.repeat(32),
      zone_id: saas.id,
      hostname: 'shop.tenant-a.com',
      status: 'active',
      ssl: { status: 'active', method: 'http', validation_records: [], validation_errors: [] },
      ownership_verification: { type: 'txt', name: '_cf-custom-hostname.shop.tenant-a.com', value: 'v' },
    });
    const challenge = await client.ownership.createChallenge({ hostname: 'shop.tenant-a.com', tenantId: 'tenant-a' });
    env.dns.set(challenge.record.name, 'TXT', [challenge.record.content]);
    const input = {
      domain: 'shop.tenant-a.com',
      routing: {
        strategy: 'saas-custom-hostname' as const,
        saasZoneId: saas.id,
        cnameTarget: 'customers.platform.com',
      },
      confirm: true,
    };
    return { env, client, input };
  }

  it('refuses to remove a hostname whose challenge belongs to another tenant', async () => {
    const { env, client, input } = await saasEnv();
    const result = await client.workflows.removeCustomDomain({ ...input, tenantId: 'tenant-b' });
    expect(result.lifecycle).toBe('failed');
    expect(result.errors[0]).toMatchObject({ step: 'tenant', code: 'TENANT_CONFLICT' });
    expect(result.removed.customHostnames).toEqual([]);
    expect(env.cf.customHostnames).toHaveLength(1);
  });

  it('requires the owning tenantId when a challenge is published', async () => {
    const { env, client, input } = await saasEnv();
    const result = await client.workflows.removeCustomDomain(input);
    expect(result.errors[0]).toMatchObject({ step: 'tenant', code: 'TENANT_CONFLICT' });
    expect(env.cf.customHostnames).toHaveLength(1);
  });

  it('stops when the challenge cannot be looked up', async () => {
    const { env, client, input } = await saasEnv();
    env.dns.failing = true;
    const result = await client.workflows.removeCustomDomain({ ...input, tenantId: 'tenant-a' });
    expect(result.errors[0]).toMatchObject({ step: 'tenant', code: 'NETWORK_ERROR', retryable: true });
    expect(env.cf.customHostnames).toHaveLength(1);
  });

  it('removes the hostname for the owning tenant', async () => {
    const { env, client, input } = await saasEnv();
    const result = await client.workflows.removeCustomDomain({ ...input, tenantId: 'tenant-a' });
    expect(result.lifecycle).toBe('disabled');
    expect(result.removed.customHostnames).toEqual(['shop.tenant-a.com']);
    expect(env.cf.customHostnames).toHaveLength(0);
  });

  it('removes the hostname when the tenant has since removed the challenge', async () => {
    const { env, client, input } = await saasEnv();
    env.dns.clear('_domainwright.shop.tenant-a.com');
    const result = await client.workflows.removeCustomDomain({ ...input, tenantId: 'tenant-a' });
    expect(result.lifecycle).toBe('disabled');
    expect(env.cf.customHostnames).toHaveLength(0);
  });
});

describe('getStatus', () => {
  it('maps verification onto the lifecycle without changing anything', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.workflows.setupCustomDomain({ domain: 'status.com', worker: { name: 'app' } });
    const writes = env.requests.filter((r) => /^(POST|PUT|PATCH|DELETE)/.test(r)).length;
    const status = await client.workflows.getStatus({
      domain: 'status.com',
      worker: { name: 'app' },
      routing: { strategy: 'custom-domain' },
    });
    expect(status.lifecycle).toBe('verifying');
    expect(env.requests.filter((r) => /^(POST|PUT|PATCH|DELETE)/.test(r)).length).toBe(writes);
  });
});
