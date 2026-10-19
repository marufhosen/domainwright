# Module guide

Every module works on its own. The workflows only compose them.

- [Domain search](#domain-search)
- [Domain registration](#domain-registration)
- [Cloudflare zones](#cloudflare-zones)
- [DNS records](#dns-records)
- [Worker integration](#worker-integration)
- [Cloudflare for SaaS custom hostnames](#cloudflare-for-saas-custom-hostnames)
- [Certificates](#certificates)
- [Ownership challenges](#ownership-challenges)
- [Verification](#verification)
- [Using modules without the DomainPilot client](#using-modules-without-the-domainpilot-client)

## Domain search

```ts
const { results, available } = await client.domains.search({
  keyword: 'mypropertyapp',
  tlds: ['.com', '.io', '.app'],
  includeSuggestions: true, // optional registrar suggestions
  confirmSuggestions: true, // default: re-check suggestions in real time
});

for (const r of results) {
  // r.availability: 'available' | 'unavailable' | 'unknown'
  // r.confirmed:   true only when the registrar's real-time check produced the result
  // r.source:      'exact' (you asked for it) | 'suggestion'
  console.log(
    r.domain,
    r.availability,
    r.confirmed,
    r.source,
    r.premium,
    r.registrationPrice,
    r.renewalPrice,
    r.reason,
  );
}
```

- `available` contains only confirmed, standard-registration results.
- `unknown` means availability could not be determined (registry maintenance, unsupported TLD, unconfirmed suggestion). Treat it as "do not sell".
- `client.domains.check(['a.com', 'b.io'])` checks specific names.
- Searching or checking never purchases anything.

## Domain registration

```ts
const result = await client.domains.purchase({
  domain: 'mypropertyapp.com',
  years: 1,
  maxPrice: { amount: 20, currency: 'USD' }, // required spending authorization
  idempotencyKey: savedKey, // optional; generated and returned when omitted
  allowPremium: false, // default
  privacy: true,
  autoRenew: false,
  contacts: {
    registrant: {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+1.5555550100',
      address1: '1 Main St',
      city: 'Springfield',
      zip: '12345',
      country: 'US',
    },
  },
});

result.status; // 'registered' | 'pending' | 'action-required' | 'already-owned'
result.orderId;
result.totalPaid; // { amount, currency }
result.expiresAt;
result.idempotencyKey; // persist this
result.replayed; // true if the registrar replayed a cached result for the same key
```

Safeguards, in order:

1. If the domain is already in your registrar account, `status: 'already-owned'` is returned and nothing is charged.
2. Availability must be confirmed in real time.
3. Premium prices require `allowPremium: true`; the exact premium price is fetched and sent.
4. The registrar's quote for the whole term must not exceed `maxPrice` (same currency).
5. The request carries an idempotency key and is never retried automatically. A timeout, network failure or 5xx raises `PURCHASE_OUTCOME_UNKNOWN`; see [Errors](errors.md#purchases).

Other registrar operations:

```ts
await client.domains.getRegistration('mypropertyapp.com'); // expiry, auto-renew, lock, nameservers, renewal price; null if not in the account
await client.domains.renew({ domain: 'mypropertyapp.com', years: 1, maxPrice: 20 });
await client.domains.setNameservers({ domain: 'mypropertyapp.com', nameservers: zone.nameservers, confirm: true });
```

## Cloudflare zones

Registering a domain and creating a Cloudflare zone are separate operations. A zone is Cloudflare's authoritative DNS for the domain; it becomes `active` only after the registrar points the domain at the nameservers Cloudflare assigned.

```ts
const zone = await client.cloudflare.zones.create({ domain: 'mypropertyapp.com' });
zone.created; // false when an existing zone in the account was reused
zone.id;
zone.status; // 'initializing' | 'pending' | 'active' | 'moved'
zone.nameservers; // assigned Cloudflare nameservers
zone.nameserverInstructions?.instructions; // present until the zone is active

await client.cloudflare.zones.find('mypropertyapp.com'); // Zone | null
await client.cloudflare.zones.findForHostname('shop.tenant-a.example.com'); // walks up to the containing zone
await client.cloudflare.zones.getNameservers('mypropertyapp.com');
await client.cloudflare.zones.triggerActivationCheck(zone.id); // ask Cloudflare to re-check delegation
await client.cloudflare.zones.waitForActive(zone.id, { timeoutMs: 600_000, intervalMs: 30_000 });
await client.cloudflare.zones.delete({ zoneId: zone.id, confirm: true }); // destructive
```

## DNS records

```ts
// Root and subdomain records; names may be '@', relative ('www') or fully qualified.
await client.cloudflare.dns.create({
  domain: 'example.com',
  type: 'A',
  name: '@',
  content: '192.0.2.10',
  proxied: true,
});
await client.cloudflare.dns.create({
  domain: 'example.com',
  type: 'CNAME',
  name: 'www',
  content: 'example.com',
  proxied: true,
});
await client.cloudflare.dns.create({
  domain: 'example.com',
  type: 'MX',
  name: '@',
  content: 'mx.mail.example',
  priority: 10,
});
await client.cloudflare.dns.create({ domain: 'example.com', type: 'TXT', name: '_verify', content: 'token', ttl: 300 });
await client.cloudflare.dns.create({
  zoneId,
  type: 'SRV',
  name: '_sip._tcp',
  data: { priority: 10, weight: 5, port: 5060, target: 'sip.example.com' },
});

const records = await client.cloudflare.dns.list({ domain: 'example.com', name: 'www', type: 'CNAME' });
await client.cloudflare.dns.update({ domain: 'example.com', recordId, changes: { content: '192.0.2.11' } });
await client.cloudflare.dns.delete({ domain: 'example.com', recordId, confirm: true });
```

- Input is validated before any request (addresses, hostnames, TTL `1` or 30-86400, priority for MX/URI, proxying only for A/AAAA/CNAME, CAA syntax).
- Defaults: `ttl: 1` (automatic), `proxied: false`.
- An identical record is reused (`created: false`), or rejected with `onDuplicate: 'error'`.
- CNAME conflicts (a CNAME next to any other record at the same name) are detected before the API call and thrown as `CONFLICT` with the conflicting records in `details.conflicts`.
- Records created by DomainPilot carry a marker in their comment (`[domainpilot]` or `[domainpilot t=<tenant tag>]`). `update` and `delete` refuse records without the marker unless you pass `allowUnmanaged: true`, so existing customer records are never changed by accident.

## Worker integration

DomainPilot connects hostnames to Workers you have already deployed. It never deploys or modifies Worker code.

```ts
// Workers Custom Domains: Cloudflare manages the DNS record and certificate.
const attached = await client.cloudflare.workers.customDomains.attach({
  hostname: 'shop.example.com',
  service: 'storefront-production',
  zoneId,
});
await client.cloudflare.workers.customDomains.list({ service: 'storefront-production' });
await client.cloudflare.workers.customDomains.findByHostname('shop.example.com');
await client.cloudflare.workers.customDomains.detach({ domainId: attached.id, confirm: true });

// Workers Routes: requires a proxied DNS record for the hostname.
await client.cloudflare.dns.create({ zoneId, type: 'AAAA', name: 'shop', content: '100::', proxied: true });
await client.cloudflare.workers.routes.create({
  zoneId,
  pattern: 'shop.example.com/*',
  script: 'storefront-production',
});
```

Attaching a hostname that is already attached to a different Worker, or re-pointing a route at a different Worker, throws `TENANT_CONFLICT` unless you pass `allowReassign: true`. With Wrangler environments, Worker `name` + `environment` deploys as `name-environment`; the `WorkerTarget` type (`{ name, environment }`) resolves to that service name, or pass `service` explicitly.

## Cloudflare for SaaS custom hostnames

```ts
const custom = await client.cloudflare.customHostnames.create({
  zoneId: saasZoneId,
  hostname: 'shop.tenant.com',
  sslMethod: 'http',
});
custom.status; // 'pending' | 'active' | ...
custom.ssl.readiness; // 'pending' | 'active' | 'failed' | 'missing'
custom.ownershipVerification; // optional TXT pre-validation record for the tenant
await client.cloudflare.customHostnames.find(saasZoneId, 'shop.tenant.com');
await client.cloudflare.customHostnames.delete({ zoneId: saasZoneId, customHostnameId: custom.id, confirm: true });
```

## Certificates

```ts
const cert = await client.cloudflare.certificates.statusFor(zoneId, 'shop.example.com');
cert.readiness; // 'active' | 'pending' | 'failed' | 'missing'
cert.status; // raw Cloudflare status, e.g. 'pending_validation'
```

## Ownership challenges

```ts
const challenge = await client.ownership.createChallenge({ hostname: 'shop.tenant.com', tenantId: 'tenant_123' });
challenge.record; // { type: 'TXT', name: '_domainpilot.shop.tenant.com', content: 'domainpilot-verification=...' }
challenge.instructions;

const result = await client.ownership.verifyChallenge({ hostname: 'shop.tenant.com', tenantId: 'tenant_123' });
result.status; // 'passed' | 'pending' | 'failed' (another tenant's record) | 'error' (lookup failed)
```

Tokens are derived, not stored: the same tenant and hostname always produce the same token, and a token for one tenant never verifies another.

## Verification

```ts
const report = await client.domains.verify({
  domain: 'example.com',
  hostnames: ['example.com', 'www.example.com'],
  tenantId: 'tenant_123',
  routing: { strategy: 'custom-domain' },
  worker: { name: 'storefront', environment: 'production' },
  https: { path: '/healthz', header: { name: 'x-tenant-id', value: 'tenant_123' } },
  waitForReady: true,
  timeoutMs: 300_000,
  intervalMs: 15_000,
});
```

See [Verification and statuses](verification.md) for every check.

## Using modules without the DomainPilot client

```ts
import { CloudflareClient } from '@your-scope/domainpilot/cloudflare';
import { NameComRegistrar } from '@your-scope/domainpilot/registrars/namecom';

const cloudflare = new CloudflareClient({ apiToken: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID });
await cloudflare.zones.create({ domain: 'example.com' });

const registrar = new NameComRegistrar({
  provider: 'namecom',
  username: env.NAMECOM_USERNAME,
  apiToken: env.NAMECOM_API_TOKEN,
  environment: 'sandbox',
});
await registrar.checkAvailability(['example.com']);
```

The low-level adapter methods skip the client's purchase safeguards (`maxPrice`, already-owned check, availability confirmation). Prefer `client.domains.purchase` for purchases.
