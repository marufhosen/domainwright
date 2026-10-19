import { describe, expect, it } from 'vitest';
import { PurchaseError, UnsupportedOperationError, isDomainwrightError } from '../../src/index.js';
import type { RegistrarAdapter } from '../../src/index.js';
import { createTestEnv } from '../fakes/env.js';

describe('domains.search', () => {
  it('checks keyword x TLD combinations with confirmed availability and pricing', async () => {
    const env = createTestEnv();
    env.namecom.taken.add('mypropertyapp.com');
    const { results, available } = await env
      .client()
      .domains.search({ keyword: 'mypropertyapp', tlds: ['.com', '.io', '.app'] });
    expect(results.map((r) => [r.domain, r.availability, r.confirmed, r.source])).toEqual([
      ['mypropertyapp.com', 'unavailable', true, 'exact'],
      ['mypropertyapp.io', 'available', true, 'exact'],
      ['mypropertyapp.app', 'available', true, 'exact'],
    ]);
    expect(results[1]?.registrationPrice).toEqual({ amount: 12.99, currency: 'USD' });
    expect(available.map((r) => r.domain)).toEqual(['mypropertyapp.io', 'mypropertyapp.app']);
    expect(env.namecom.calls.every((c) => c.method !== 'POST' || !c.path.endsWith('/domains'))).toBe(true);
  });

  it('marks suggestions separately and confirms them in real time', async () => {
    const env = createTestEnv();
    const { results } = await env.client().domains.search({ keyword: 'acme', tlds: ['com'], includeSuggestions: true });
    const suggestion = results.find((r) => r.source === 'suggestion');
    expect(suggestion).toMatchObject({ domain: 'getacme.com', confirmed: true, availability: 'available' });
    const unconfirmed = await env
      .client()
      .domains.search({ keyword: 'acme', tlds: ['com'], includeSuggestions: true, confirmSuggestions: false });
    expect(unconfirmed.results.find((r) => r.source === 'suggestion')?.confirmed).toBe(false);
    expect(unconfirmed.available.every((r) => r.source === 'exact')).toBe(true);
  });

  it('reports availability that could not be confirmed as unknown', async () => {
    const env = createTestEnv();
    const [result] = await env.client().domains.check(['example.maint']);
    expect(result).toMatchObject({ availability: 'unknown', reason: 'Registry maintenance' });
  });
});

describe('domains.purchase', () => {
  it('requires an explicit spending limit', async () => {
    const env = createTestEnv();
    const client = env.client();
    // @ts-expect-error maxPrice is required
    await expect(client.domains.purchase({ domain: 'new.com', years: 1 })).rejects.toMatchObject({
      code: 'PURCHASE_NOT_AUTHORIZED',
    });
    await expect(client.domains.purchase({ domain: 'new.com', years: 2, maxPrice: 20 })).rejects.toMatchObject({
      code: 'PURCHASE_NOT_AUTHORIZED',
    });
    expect(env.namecom.orders).toBe(0);
  });

  it('registers with an idempotency key and returns order details', async () => {
    const env = createTestEnv();
    const result = await env
      .client()
      .domains.purchase({ domain: 'mypropertyapp.com', years: 1, maxPrice: { amount: 15, currency: 'USD' } });
    expect(result).toMatchObject({
      domain: 'mypropertyapp.com',
      status: 'registered',
      orderId: '1001',
      replayed: false,
      registrar: 'namecom',
    });
    expect(result.idempotencyKey).toMatch(/[0-9a-f-]{36}/);
    const create = env.namecom.calls.find((c) => c.method === 'POST' && c.path === '/core/v1/domains');
    expect(create?.headers['x-idempotency-key']).toBe(result.idempotencyKey);
    expect(create?.body).not.toHaveProperty('purchasePrice');
  });

  it('returns already-owned instead of buying twice', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.domains.purchase({ domain: 'dup.com', maxPrice: 15 });
    const second = await client.domains.purchase({ domain: 'dup.com', maxPrice: 15 });
    expect(second.status).toBe('already-owned');
    expect(env.namecom.orders).toBe(1);
  });

  it('replays safely with the same idempotency key', async () => {
    const env = createTestEnv();
    const client = env.client();
    env.namecom.nextCreate = 'server-error-after-processing';
    const error = await client.domains
      .purchase({ domain: 'flaky.com', maxPrice: 15, idempotencyKey: 'key-1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PurchaseError);
    expect(error).toMatchObject({ code: 'PURCHASE_OUTCOME_UNKNOWN', details: { idempotencyKey: 'key-1' } });
    // The domain is now owned, so a repeat short-circuits without charging again.
    const retry = await client.domains.purchase({ domain: 'flaky.com', maxPrice: 15, idempotencyKey: 'key-1' });
    expect(retry.status).toBe('already-owned');
    expect(env.namecom.orders).toBe(1);
  });

  it('never retries a purchase after a network failure', async () => {
    const env = createTestEnv();
    env.namecom.nextCreate = 'network';
    const error = await env
      .client()
      .domains.purchase({ domain: 'net.com', maxPrice: 15 })
      .catch((e: unknown) => e);
    expect(isDomainwrightError(error, 'PURCHASE_OUTCOME_UNKNOWN')).toBe(true);
    expect(env.namecom.calls.filter((c) => c.path === '/core/v1/domains' && c.method === 'POST')).toHaveLength(1);
  });

  it('maps payment failures', async () => {
    const env = createTestEnv();
    env.namecom.nextCreate = 'payment';
    await expect(env.client().domains.purchase({ domain: 'pay.com', maxPrice: 15 })).rejects.toMatchObject({
      code: 'PAYMENT_FAILED',
      status: 402,
    });
  });

  it('refuses unavailable domains and premium names without opt-in', async () => {
    const env = createTestEnv();
    const client = env.client();
    await expect(client.domains.purchase({ domain: 'taken.com', maxPrice: 15 })).rejects.toMatchObject({
      code: 'DOMAIN_UNAVAILABLE',
    });
    await expect(client.domains.purchase({ domain: 'gold.com', maxPrice: 5000 })).rejects.toMatchObject({
      code: 'PURCHASE_NOT_AUTHORIZED',
    });
    await expect(
      client.domains.purchase({ domain: 'gold.com', maxPrice: 100, allowPremium: true }),
    ).rejects.toMatchObject({ code: 'PURCHASE_NOT_AUTHORIZED' });
    const premium = await client.domains.purchase({ domain: 'gold.com', maxPrice: 5000, allowPremium: true });
    expect(premium.status).toBe('registered');
    const create = env.namecom.calls.find((c) => c.method === 'POST' && c.path === '/core/v1/domains');
    expect((create?.body as { purchasePrice: number }).purchasePrice).toBe(2500);
  });

  it('reads registration details and changes nameservers only when confirmed', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.domains.purchase({ domain: 'ns.com', maxPrice: 15 });
    const reg = await client.domains.getRegistration('ns.com');
    expect(reg).toMatchObject({
      domain: 'ns.com',
      expiresAt: '2027-10-19T00:00:00Z',
      nameservers: ['ns1.name.com', 'ns2.name.com'],
    });
    expect(await client.domains.getRegistration('unknown.com')).toBeNull();
    await expect(
      client.domains.setNameservers({ domain: 'ns.com', nameservers: ['a.ns.cloudflare.com'], confirm: false }),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    const updated = await client.domains.setNameservers({
      domain: 'ns.com',
      nameservers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'],
      confirm: true,
    });
    expect(updated.nameservers).toEqual(['a.ns.cloudflare.com', 'b.ns.cloudflare.com']);
  });

  it('renews within the authorized limit', async () => {
    const env = createTestEnv();
    const client = env.client();
    await client.domains.purchase({ domain: 'renew.com', maxPrice: 15 });
    await expect(client.domains.renew({ domain: 'renew.com', maxPrice: 1 })).rejects.toMatchObject({
      code: 'PURCHASE_NOT_AUTHORIZED',
    });
    const renewed = await client.domains.renew({ domain: 'renew.com', maxPrice: 15 });
    expect(renewed.status).toBe('registered');
  });
});

describe('custom registrar adapters', () => {
  it('reports unsupported operations instead of assuming them', async () => {
    const searchOnly: RegistrarAdapter = {
      id: 'search-only',
      displayName: 'Search Only',
      capabilities: {
        checkAvailability: true,
        suggestions: false,
        pricing: false,
        register: false,
        idempotentRegistration: false,
        renew: false,
        getDomain: false,
        setNameservers: false,
      },
      async checkAvailability(domains) {
        return domains.map((domain) => ({
          domain,
          tld: 'com',
          availability: 'available',
          confirmed: true,
          premium: false,
          registrar: 'search-only',
        }));
      },
    };
    const env = createTestEnv();
    const client = env.client({ registrar: searchOnly });
    expect((await client.domains.search({ domains: ['x.com'] })).available).toHaveLength(1);
    await expect(client.domains.purchase({ domain: 'x.com', maxPrice: 10 })).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(client.domains.search({ keyword: 'x', includeSuggestions: true })).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
  });
});
