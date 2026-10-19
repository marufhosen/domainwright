/**
 * Live tests against the name.com sandbox (https://api.dev.name.com). Never part of `npm test`.
 *
 *   NAMECOM_SANDBOX_USERNAME=acme-test NAMECOM_SANDBOX_TOKEN=... npm run test:sandbox
 *
 * The purchase test additionally requires DOMAINPILOT_SANDBOX_ALLOW_PURCHASE=1. Sandbox
 * purchases use test credit, but sandbox domains cannot be deleted afterwards.
 */
import { describe, expect, it } from 'vitest';
import { DomainPilot } from '../../src/index.js';

const username = process.env.NAMECOM_SANDBOX_USERNAME;
const apiToken = process.env.NAMECOM_SANDBOX_TOKEN;
const enabled = Boolean(username && apiToken);

describe.skipIf(!enabled)('name.com sandbox', () => {
  const client = (): DomainPilot =>
    new DomainPilot({
      registrar: { provider: 'namecom', username: username!, apiToken: apiToken!, environment: 'sandbox' },
    });

  it('checks availability and suggestions', async () => {
    const keyword = `domainpilot-${Date.now().toString(36)}`;
    const { results } = await client().domains.search({ keyword, tlds: ['com', 'net'], includeSuggestions: true });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(['available', 'unavailable', 'unknown']).toContain(r.availability);
  });

  it.skipIf(process.env.DOMAINPILOT_SANDBOX_ALLOW_PURCHASE !== '1')(
    'purchases idempotently in the sandbox',
    async () => {
      const domain = `domainpilot-${Date.now().toString(36)}.com`;
      const first = await client().domains.purchase({ domain, years: 1, maxPrice: 50 });
      expect(first.status).toBe('registered');
      const second = await client().domains.purchase({
        domain,
        years: 1,
        maxPrice: 50,
        idempotencyKey: first.idempotencyKey,
      });
      expect(second.status).toBe('already-owned');
      const registration = await client().domains.getRegistration(domain);
      expect(registration?.domain).toBe(domain);
    },
  );
});
