/**
 * Each module works without the workflows.
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... NAMECOM_USERNAME=acme-test NAMECOM_API_TOKEN=... \
 *   DOMAINWRIGHT_OWNERSHIP_SECRET=... npx tsx examples/independent-modules.ts
 */
import { Domainwright, isDomainwrightError } from '../src/index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

const client = new Domainwright({
  cloudflare: { apiToken: requireEnv('CLOUDFLARE_API_TOKEN'), accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID') },
  registrar: {
    provider: 'namecom',
    username: requireEnv('NAMECOM_USERNAME'),
    apiToken: requireEnv('NAMECOM_API_TOKEN'),
    environment: 'sandbox',
  },
  ownership: { secret: requireEnv('DOMAINWRIGHT_OWNERSHIP_SECRET') },
});

async function main(): Promise<void> {
  // Search: never purchases anything.
  const { available, results } = await client.domains.search({ keyword: 'mypropertyapp', tlds: ['com', 'io'] });
  for (const r of results) console.log(r.domain, r.availability, r.confirmed ? 'confirmed' : 'unconfirmed');
  console.log(
    'can sell:',
    available.map((r) => r.domain),
  );

  // Zones: reuses an existing zone instead of creating a duplicate.
  const zone = await client.cloudflare.zones.create({ domain: 'example.com' });
  console.log(zone.created ? 'created' : 'reused', zone.id, zone.nameservers);

  // DNS: creating the same record twice returns the existing record.
  const record = await client.cloudflare.dns.create({
    domain: 'example.com',
    type: 'CNAME',
    name: 'www',
    content: 'example.com',
    proxied: true,
  });
  console.log(record.created ? 'created' : 'already present', record.id);

  // Ownership: show the tenant this record, then verify it.
  const challenge = await client.ownership.createChallenge({ hostname: 'shop.tenant.example', tenantId: 'tenant_123' });
  console.log(challenge.instructions);
  const ownership = await client.ownership.verifyChallenge({ hostname: 'shop.tenant.example', tenantId: 'tenant_123' });
  console.log('ownership:', ownership.status);

  // Verification: read-only checks.
  const report = await client.verify({ domain: 'example.com', hostnames: ['example.com', 'www.example.com'] });
  console.log(report.summary, report.outstandingActions);
}

main().catch((error: unknown) => {
  if (isDomainwrightError(error)) console.error(error.code, error.message);
  else console.error(error);
  process.exitCode = 1;
});
