# Workflow guide

`client.workflows.setupCustomDomain` runs the onboarding steps in order and returns a structured result. It is safe to call repeatedly: every step either confirms existing resources or creates missing ones, and a completed purchase is never repeated.

## Steps

| #   | Step           | What happens                                                                                                                                                                                                                                                                                                     |
| --- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `validate`     | Input and configuration checks. Invalid input throws `ValidationError` / `ConfigurationError` before anything else runs.                                                                                                                                                                                         |
| 2   | `registration` | Only when `registration: { purchase: true, maxPrice }` is passed. Persists an idempotency key via `onCheckpoint` _before_ the purchase is sent, then purchases with the same safeguards as `domains.purchase`.                                                                                                   |
| 3   | `zone`         | Finds or creates the zone (`custom-domain`, `route`), or loads the SaaS zone (`saas-custom-hostname`). For a tenant subdomain (`zone.name` set) the parent zone must already exist; it is never created or deleted.                                                                                              |
| 4   | `ownership`    | With `tenantId`: zone strategies write (or confirm) a tenant-bound marker TXT at `_domainpilot.<domain>` in the zone and refuse zones claimed by another tenant; the SaaS strategy waits for the tenant to publish the challenge TXT. Runs before anything changes registrar or routing state.                   |
| 5   | `nameservers`  | Active zone: done. Domain in your registrar account and `nameservers.updateAtRegistrar: true`: sets the Cloudflare nameservers and asks Cloudflare to re-check. Otherwise: `waiting` with an `update-nameservers` action.                                                                                        |
| 6   | `dns`          | `route`: a proxied record per hostname (reuses an existing proxied record, else creates an originless `AAAA 100::`). `custom-domain`: checks no conflicting A/AAAA/CNAME exists (Cloudflare manages the record). `saas-custom-hostname`: returns the CNAME the tenant must add. Plus any `dns.records` you pass. |
| 7   | `routing`      | Attaches Workers Custom Domains, creates `hostname/*` routes, or creates SaaS custom hostnames (after ownership is verified). Never moves a hostname from another Worker unless `reassign.allowed`.                                                                                                              |
| 8   | `verification` | Runs every readiness check once, or polls with `verification.waitForReady`.                                                                                                                                                                                                                                      |

Each step reports `pending`, `succeeded`, `skipped`, `waiting`, `failed` or `planned` (dry run), with `message`, `actions` and `error`.

## Input

```ts
const result = await client.workflows.setupCustomDomain({
  domain: 'marketplace-a.com', // apex, or a tenant subdomain such as 'tenant-a.example.com'
  tenantId: 'tenant_123', // optional; enables tenant-bound ownership (needs ownership.secret)
  worker: { name: 'property-source', environment: 'production' }, // or { name, service }
  routing: { strategy: 'custom-domain' }, // default; or { strategy: 'route' } or SaaS (see below)
  dns: {
    root: true, // default
    www: true,
    subdomains: ['shop'],
    records: [{ type: 'MX', name: '@', content: 'mx.mail.example', priority: 10 }],
    replaceManagedRecords: false, // allow replacing conflicting records DomainPilot created for this tenant
  },
  zone: { name: undefined, adoptExisting: false },
  registration: { purchase: true, years: 1, maxPrice: { amount: 20, currency: 'USD' } }, // optional
  nameservers: { updateAtRegistrar: false }, // explicit authorization to change nameservers
  reassign: { allowed: false }, // explicit authorization to move a domain between tenants/Workers
  verification: { waitForReady: false, timeoutMs: 300_000, intervalMs: 15_000, https: { path: '/healthz' } },
  dryRun: false,
  resumeFrom: undefined, // a previous result.state
  onCheckpoint: async (state) => {
    await db.save(state);
  },
  signal: abortController.signal,
});
```

## Result

```ts
result.lifecycle; // 'pending' | 'registering' | 'configuring' | 'verifying' | 'active' | 'failed'
result.ready; // true only when verification passed every required check
result.steps; // per-step status, messages, actions, errors, planned changes
result.verification; // the full VerificationReport, when verification ran
result.outstandingActions; // what still has to happen, and who must do it
result.errors; // [{ step, code, message, retryable, ... }]
result.state; // persist this, then pass it as resumeFrom
```

A partially configured domain is never reported as operational: `ready` stays `false` and `lifecycle` stays below `active` until verification passes.

## Persisting and resuming

`result.state` is plain JSON. Store it alongside your tenant-domain mapping (it contains resource IDs, not secrets). To continue:

```ts
const result = await client.workflows.setupCustomDomain({ ...sameInput, resumeFrom: savedState });
```

- The state must match the domain, tenant, strategy and Worker, otherwise `WORKFLOW_STATE_MISMATCH` is thrown.
- A succeeded `registration` step is skipped. Every other step re-runs, which is cheap (lookups) and catches drift.
- If a purchase was sent but its outcome is unknown, the resumed run first looks the domain up in the registrar account; if it is there, the step succeeds without buying again. Otherwise it repeats the request with the same idempotency key, which name.com replays instead of charging twice, but only within 55 minutes of the original attempt. After that, the step fails with `PURCHASE_OUTCOME_UNKNOWN` and asks you to check the order history.
- If the registrar accepted the order but reported it `pending` or `action-required`, the state records that status and the step waits. A resumed run checks the registrar account and succeeds once the domain appears there; it never submits the order again.
- If `onCheckpoint` throws right before a purchase, the purchase is not sent.

A typical integration resumes on a schedule (a Cron Trigger or queue) until `lifecycle` is `active` or `failed`, and shows `outstandingActions` to the tenant meanwhile.

## Dry run

```ts
const plan = await client.workflows.setupCustomDomain({ ...input, dryRun: true });
plan.steps.flatMap((s) => s.planned ?? []); // [{ operation: 'cloudflare.zones.create', target: 'marketplace-a.com' }, ...]
```

A dry run performs read requests only (lookups, availability and price checks) and makes no changes. `onCheckpoint` is not called.

## Purchasing in the workflow

```ts
await client.workflows.setupCustomDomain({
  domain: 'mypropertyapp.com',
  worker: { name: 'property-source' },
  registration: { purchase: true, years: 1, maxPrice: 20 },
  nameservers: { updateAtRegistrar: true }, // point the new domain at Cloudflare
  onCheckpoint: save,
});
```

Purchases happen only when `registration.purchase` is `true` and a registrar is configured. Nameserver changes still need `updateAtRegistrar: true`, even for a domain purchased in the same run.

## Cloudflare for SaaS

```ts
await client.workflows.setupCustomDomain({
  domain: 'shop.tenant.com',
  tenantId: 'tenant_123',
  worker: { name: 'storefront' },
  routing: { strategy: 'saas-custom-hostname', saasZoneId: env.SAAS_ZONE_ID, cnameTarget: 'customers.platform.com' },
});
```

The first run returns `waiting` with two tenant actions: publish the DomainPilot TXT challenge, and add the CNAME. The custom hostname is created only after the challenge verifies, so no other tenant can claim the hostname first. Resume until `active`.

## Status without changes

```ts
const { lifecycle, verification } = await client.workflows.getStatus({
  domain: 'marketplace-a.com',
  hostnames: ['marketplace-a.com', 'www.marketplace-a.com'],
  tenantId: 'tenant_123',
  routing: { strategy: 'custom-domain' },
  worker: { name: 'property-source', environment: 'production' },
});
```

## Removal

See [Removing a domain safely](removal.md).
