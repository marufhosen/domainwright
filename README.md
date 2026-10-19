# DomainPilot

Custom-domain onboarding for multi-tenant SaaS applications on Cloudflare Workers.

DomainPilot is a TypeScript SDK with independent modules for domain search and registration, Cloudflare zones, DNS, Worker routing, ownership verification and readiness checks, plus a resumable workflow that runs them in order and tells you exactly what is done, what is pending and what someone still has to do.

- **Modular.** Buy a domain without touching DNS, configure DNS for a domain you already own, verify an existing setup, or run the full onboarding.
- **Safe by default.** Purchases need an explicit price limit. Deletions, nameserver changes and reassignments need explicit confirmation. Records DomainPilot did not create are never changed.
- **Honest status.** A successful API call is never reported as "ready". Every check (delegation, ownership, routing, certificate, public DNS, HTTPS) is reported separately.
- **Tenant-aware, database-free.** Ownership tokens are derived from your secret, the tenant ID and the hostname, so one tenant can never claim another tenant's domain, and the SDK never needs your database.
- **Runs on Node.js 20+ and Cloudflare Workers.** Zero runtime dependencies; only `fetch`, Web Crypto and `URL`.

> Package name: the package is published under a placeholder scope, `@your-scope/domainpilot`. Change `name` in `package.json` before publishing (see [Releasing](CONTRIBUTING.md#releasing)).

## Contents

- [Install](#install)
- [Configure](#configure)
- [Use a single module](#use-a-single-module)
- [Onboard a tenant domain end to end](#onboard-a-tenant-domain-end-to-end)
- [Routing strategies](#routing-strategies)
- [Lifecycle states](#lifecycle-states)
- [What DomainPilot automates and what it does not](#what-domainpilot-automates-and-what-it-does-not)
- [Guides](#guides)

## Install

```sh
npm install @your-scope/domainpilot
```

Entry points (all ESM, with TypeScript declarations):

| Import                                       | Contents                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `@your-scope/domainpilot`                    | Everything, including the `DomainPilot` client                           |
| `@your-scope/domainpilot/cloudflare`         | `CloudflareClient` (zones, DNS, Workers, custom hostnames, certificates) |
| `@your-scope/domainpilot/registrars`         | Registrar adapter interface and built-in adapters                        |
| `@your-scope/domainpilot/registrars/namecom` | `NameComRegistrar`                                                       |
| `@your-scope/domainpilot/verification`       | `DomainVerifier`, DNS-over-HTTPS resolver, `OwnershipModule`             |
| `@your-scope/domainpilot/workflows`          | Workflow functions and their types                                       |
| `@your-scope/domainpilot/errors`             | Error classes and codes                                                  |

## Configure

All credentials come from your application. DomainPilot keeps them in memory only, never logs them and never includes them in errors or results. Creating a client makes no network calls.

```ts
import { DomainPilot } from '@your-scope/domainpilot';

const client = new DomainPilot({
  cloudflare: {
    apiToken: env.CLOUDFLARE_API_TOKEN,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
  },
  registrar: {
    provider: 'namecom',
    username: env.NAMECOM_USERNAME, // sandbox usernames end in "-test"
    apiToken: env.NAMECOM_API_TOKEN,
    environment: 'sandbox', // or 'production'; required, so live purchases are always deliberate
  },
  ownership: {
    secret: env.DOMAINPILOT_OWNERSHIP_SECRET, // at least 32 characters, keep it stable
  },
});
```

Every block is optional, but at least one provider is required. Use separate clients (and separate credentials) for development and production. See [Credentials and permissions](docs/credentials-and-permissions.md) for the minimum Cloudflare token permissions per module, and [.env.example](.env.example) for variable names.

Check a Cloudflare token before relying on it:

```ts
const { active } = await client.cloudflare.verifyToken();
const access = await client.cloudflare.checkAccess(); // probes read access per module
```

## Use a single module

```ts
// Search: never purchases. Results distinguish confirmed availability from suggestions.
const { results, available } = await client.domains.search({
  keyword: 'mypropertyapp',
  tlds: ['.com', '.io', '.app'],
  includeSuggestions: true,
});

// Purchase: explicit, price-limited, idempotent, never retried automatically.
const purchase = await client.domains.purchase({
  domain: 'mypropertyapp.com',
  years: 1,
  maxPrice: { amount: 20, currency: 'USD' },
});

// Zone: reuses an existing zone instead of creating a duplicate.
const zone = await client.cloudflare.zones.create({ domain: 'mypropertyapp.com' });
console.log(zone.id, zone.nameservers, zone.nameserverInstructions?.instructions);

// DNS: validated, duplicate- and conflict-aware.
await client.cloudflare.dns.create({
  domain: 'mypropertyapp.com',
  type: 'TXT',
  name: '_verify',
  content: 'verification-token',
});

// Worker routing via Workers Custom Domains.
await client.cloudflare.workers.customDomains.attach({
  hostname: 'mypropertyapp.com',
  service: 'property-source-production',
  zoneId: zone.id,
});

// Verification: one result per check, never a bare boolean.
const status = await client.domains.verify({
  domain: 'mypropertyapp.com',
  worker: { name: 'property-source', environment: 'production' },
});
console.log(status.verified, status.summary, status.checks, status.errors, status.outstandingActions);
```

More: [Module guide](docs/modules.md).

## Onboard a tenant domain end to end

```ts
const result = await client.workflows.setupCustomDomain({
  domain: 'marketplace-a.com',
  tenantId: 'tenant_123',
  worker: { name: 'property-source', environment: 'production' },
  dns: { root: true, www: true },
  verification: { waitForReady: false },
  onCheckpoint: (state) => db.saveDomainState('tenant_123', 'marketplace-a.com', state),
});

result.lifecycle; // 'verifying'
result.ready; // false until every required check passes
result.outstandingActions; // e.g. [{ type: 'update-nameservers', nameservers: [...], instructions: '...' }]
result.steps; // validate, registration, zone, ownership, nameservers, dns, routing, verification

// Later (a cron, a queue consumer, or a "check again" button), resume from the saved state.
const next = await client.workflows.setupCustomDomain({
  domain: 'marketplace-a.com',
  tenantId: 'tenant_123',
  worker: { name: 'property-source', environment: 'production' },
  dns: { root: true, www: true },
  resumeFrom: await db.loadDomainState('tenant_123', 'marketplace-a.com'),
});
```

Resuming never repeats a completed purchase and never duplicates zones, records, custom domains or routes. Add `registration: { purchase: true, maxPrice: 20 }` to buy the domain first, `nameservers: { updateAtRegistrar: true }` to let DomainPilot point a domain in your registrar account at Cloudflare, and `dryRun: true` to see the plan without changing anything. See the [workflow guide](docs/workflows.md).

## Routing strategies

DomainPilot never assumes a zone or a DNS record connects a Worker. Pick a strategy explicitly with `routing`:

| Strategy                  | When to use                                                                                      | What DomainPilot configures                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `custom-domain` (default) | The tenant's zone (or the platform zone, for tenant subdomains) lives in your Cloudflare account | Workers Custom Domains; Cloudflare creates the DNS record and certificate                                      |
| `route`                   | Same, but you need path-based routes or an existing origin                                       | A proxied DNS record (originless `AAAA 100::` if none exists) and a `hostname/*` Workers Route                 |
| `saas-custom-hostname`    | Tenants keep DNS at their own provider (Cloudflare for SaaS)                                     | A custom hostname on your SaaS zone, after the tenant proves ownership; the tenant adds a CNAME to your target |

Details and trade-offs: [Routing strategies](docs/routing-strategies.md).

## Lifecycle states

| State         | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `pending`     | Nothing provisioned yet (also the result of a dry run)                                       |
| `registering` | A purchase is in progress or its outcome must be confirmed by resuming                       |
| `configuring` | Provider resources are being created, or a retryable error interrupted configuration         |
| `verifying`   | Resources exist; waiting on delegation, propagation, ownership, certificates or reachability |
| `active`      | Every required check passed. The only state that means "ready for production"                |
| `failed`      | A permanent failure that needs a change (see `errors` and `outstandingActions`)              |
| `disabled`    | Disconnected by `removeCustomDomain`                                                         |

Your application stores the tenant-to-domain mapping and the workflow state; DomainPilot returns everything you need to persist. See [Verification and statuses](docs/verification.md) and [Multi-tenant integration](docs/multi-tenant.md).

## What DomainPilot automates and what it does not

| Task                                           | Automated                                                                          | Needs                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Search, availability, pricing                  | Yes                                                                                | Registrar API (name.com)                                          |
| Purchase, renewal                              | Yes, with `maxPrice`                                                               | Registrar API, funded account                                     |
| Nameserver change                              | Only for domains in your registrar account and only with `updateAtRegistrar: true` | Otherwise returns the nameservers and instructions for the tenant |
| Zone creation, DNS records                     | Yes                                                                                | Cloudflare token with Zone and DNS edit                           |
| Worker connection                              | Yes (Custom Domains, Routes, or SaaS custom hostnames)                             | An already deployed Worker; DomainPilot never deploys code        |
| Tenant DNS at another provider                 | No                                                                                 | Returned as `add-dns-record` actions for the tenant               |
| SaaS zone setup (fallback origin, `*/*` route) | No                                                                                 | One-time platform setup; verified and reported                    |
| Certificates                                   | Issued by Cloudflare                                                               | DomainPilot waits for and reports status                          |

## Guides

- [Credentials and permissions](docs/credentials-and-permissions.md)
- [Module guide](docs/modules.md)
- [Workflow guide: onboarding, resuming, dry runs](docs/workflows.md)
- [Routing strategies](docs/routing-strategies.md)
- [Nameserver setup](docs/nameservers.md)
- [Verification and statuses](docs/verification.md)
- [Errors, retries and recovery](docs/errors.md)
- [Removing a domain safely](docs/removal.md)
- [Multi-tenant integration](docs/multi-tenant.md)
- [Next.js and Cloudflare Workers integration](docs/nextjs-cloudflare-workers.md)
- [Registrars](docs/registrars.md)
- [Runtime compatibility and limitations](docs/runtime-and-limitations.md)
- [API reference](docs/api-reference.md)
- [Testing (unit, sandbox, Workers runtime)](docs/testing.md)

## License

[MIT](LICENSE)
