/**
 * Live tests against a Cloudflare test account. Never part of `npm test`.
 *
 *   CLOUDFLARE_TEST_API_TOKEN=... CLOUDFLARE_TEST_ACCOUNT_ID=... CLOUDFLARE_TEST_ZONE=test.example.com npm run test:sandbox
 *
 * Use a dedicated account and a throwaway zone: the test creates and deletes a TXT record in it.
 */
import { describe, expect, it } from 'vitest';
import { DomainPilot } from '../../src/index.js';

const apiToken = process.env.CLOUDFLARE_TEST_API_TOKEN;
const accountId = process.env.CLOUDFLARE_TEST_ACCOUNT_ID;
const zoneName = process.env.CLOUDFLARE_TEST_ZONE;

describe.skipIf(!apiToken || !accountId || !zoneName)('Cloudflare test account', () => {
  const client = (): DomainPilot => new DomainPilot({ cloudflare: { apiToken: apiToken!, accountId: accountId! } });

  it('verifies the token and read access', async () => {
    expect((await client().cloudflare.verifyToken()).active).toBe(true);
    const report = await client().cloudflare.checkAccess();
    expect(report.checks.find((c) => c.check === 'zones:read')?.ok).toBe(true);
  });

  it('creates, reuses and deletes a managed TXT record', async () => {
    const name = `_domainpilot-sandbox-${Date.now().toString(36)}`;
    const dns = client().cloudflare.dns;
    const created = await dns.create({ domain: zoneName!, type: 'TXT', name, content: 'domainpilot sandbox test' });
    try {
      expect(created.created).toBe(true);
      const again = await dns.create({ domain: zoneName!, type: 'TXT', name, content: 'domainpilot sandbox test' });
      expect(again.id).toBe(created.id);
    } finally {
      await dns.delete({ domain: zoneName!, recordId: created.id, confirm: true });
    }
  });

  it('reports verification checks for the test zone', async () => {
    const report = await client().domains.verify({ domain: zoneName!, https: false });
    expect(report.checks.find((c) => c.id === 'zone')?.status).toBe('passed');
  });
});
