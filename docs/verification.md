# Verification and statuses

`client.domains.verify(input)` (also `client.verify`, and the workflow's last step) returns a `VerificationReport`:

```ts
const report = await client.domains.verify({
  domain: 'example.com',
  hostnames: ['example.com', 'www.example.com'], // default [domain]
  zone: undefined, // the containing zone when domain is a tenant subdomain
  tenantId: 'tenant_123', // enables the ownership check
  routing: { strategy: 'custom-domain' }, // omit to auto-detect Custom Domains or Routes
  worker: { name: 'storefront', environment: 'production' }, // omit to accept any Worker
  https: { path: '/healthz', status: [200], header: { name: 'x-tenant-id', value: 'tenant_123' } }, // or false
  checks: undefined, // restrict to some check IDs
  waitForReady: false,
  timeoutMs: 300_000,
  intervalMs: 15_000,
});

report.verified; // true only when every required check passed
report.summary; // 'verified' | 'pending' | 'failed' | 'error'
report.checks; // CheckResult[]
report.errors; // failed and errored checks, with messages
report.outstandingActions; // deduplicated actions from unfinished checks
report.timedOut; // waitForReady ran out of time
```

## Check statuses

| Status    | Meaning                                                                              | What to do                                        |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `passed`  | Verified                                                                             | Nothing                                           |
| `pending` | Expected to resolve with time (propagation, issuance) or after an outstanding action | Show `action`, check again later                  |
| `failed`  | Definitively wrong; will not fix itself                                              | Make the change described in `message` / `action` |
| `blocked` | Cannot be evaluated until an earlier check passes                                    | Look at the earlier check                         |
| `error`   | Could not be completed (provider or network error)                                   | Retry later                                       |
| `skipped` | Not applicable (`required: false`)                                                   | Nothing                                           |

`summary` is `failed` if any required check failed, else `error` if any errored, else `pending`. Polling (`waitForReady`) stops early on `failed`.

### Restricting checks

`checks` limits the report to the listed checks. Checks they depend on still run so the listed ones can be evaluated, for example `zone` and `zone-activation` for `certificate`, and `certificate` and `dns-resolution` for `https`. Those prerequisites are left out of the report unless they failed or errored, in which case they appear so the cause is visible. Checks outside the list and its prerequisites do not run.

## Checks

| ID                | Per hostname | Zone strategies                                                                                                                        | SaaS strategy                                                                     |
| ----------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `registration`    |              | Domain is in the registrar account and not expired. Skipped (not required) if registered elsewhere or no registrar is configured.      | Same                                                                              |
| `zone`            |              | Zone exists in the account                                                                                                             | SaaS zone is active                                                               |
| `nameservers`     |              | Zone active, or the registrar / public NS records compared with the assigned nameservers. Pending with an `update-nameservers` action. | Skipped                                                                           |
| `zone-activation` |              | `active` passes; `pending`/`initializing` pending; `moved` fails                                                                       | Skipped                                                                           |
| `ownership`       | SaaS: yes    | Tenant marker TXT visible in public DNS (blocked until the zone is active)                                                             | Tenant's challenge TXT in public DNS                                              |
| `dns-records`     | Yes          | `route`: a proxied A/AAAA/CNAME exists. `custom-domain`: skipped (Cloudflare-managed)                                                  | Tenant CNAME points to `cnameTarget`                                              |
| `routing`         | Yes          | Custom domain or route serves the expected Worker; another Worker fails                                                                | Custom hostname exists and is active, and a Worker route on the SaaS zone matches |
| `certificate`     | Yes          | An edge certificate covering the hostname is active (blocked until the zone is active)                                                 | Custom hostname SSL is active                                                     |
| `dns-resolution`  | Yes          | Public A/AAAA answers exist (DNS-over-HTTPS)                                                                                           | Same                                                                              |
| `https`           | Yes          | An HTTPS request completes and meets `https` expectations                                                                              | Same                                                                              |

## Making the HTTPS check prove the right application

By default any HTTP status below 500 passes, which proves DNS, TLS and that _something_ answers. To prove the hostname reaches the right tenant's application, have your Worker expose a health route that echoes the tenant it resolved, and assert on it:

```ts
https: { path: '/.well-known/domainpilot-health', status: [200], header: { name: 'x-tenant-id', value: tenantId } }
```

## Why a successful API call is not "ready"

Creating a zone, attaching a custom domain or creating a custom hostname succeeds immediately, but delegation, propagation and certificate issuance happen later and can fail. DomainPilot therefore reports those as separate checks, observed from public DNS and real HTTPS requests, and only `active` / `verified: true` means production-ready.

## Caching

Public DNS answers come from `https://cloudflare-dns.com/dns-query`, which caches according to record TTLs. A change can take up to the previous TTL to appear. Pass `dns: { dohUrl }` or a custom `dns.resolver` in the client configuration to use another resolver.
