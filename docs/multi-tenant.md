# Multi-tenant integration

Domainwright handles provider operations. Your application keeps the tenant-to-domain mapping, enforces who may manage which tenant, and persists the state Domainwright returns. Domainwright never needs access to your database, and it never trusts a tenant-to-domain association it has not verified.

## Responsibilities

| Your application                                                       | Domainwright                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| Authenticate users and authorize "tenant X may connect domain Y"       | Provider calls with your credentials                       |
| Store `{ tenantId, domain, workerTarget, strategy, state, lifecycle }` | Return that state and lifecycle on every call              |
| Decide when a domain may move between tenants                          | Refuse moves unless `reassign.allowed`                     |
| Show outstanding actions to tenants                                    | Produce them (`update-nameservers`, `add-dns-record`, ...) |
| Schedule re-checks                                                     | Resume and verify idempotently                             |

## How cross-tenant takeover is prevented

1. **Tenant-bound tokens.** With `ownership.secret` configured and `tenantId` passed, the token is `HMAC(secret, tenantId + hostname)`. A record published for tenant A never verifies tenant B.
2. **Markers in managed zones.** For zone strategies, onboarding writes the tenant's token at `_domainwright.<domain>`. A later attempt by another tenant finds a marker that does not match and stops with `TENANT_CONFLICT` before any change. A zone that already existed without a marker requires `zone.adoptExisting: true`, which your application should only pass after its own checks.
3. **Ownership before routing for SaaS.** For Cloudflare for SaaS, custom hostnames are created only after the tenant's TXT challenge verifies, so a tenant cannot pre-register someone else's hostname on your SaaS zone.
4. **No silent re-pointing.** Attaching a hostname that already serves a different Worker, or re-pointing a route, fails with `TENANT_CONFLICT` unless reassignment is authorized.
5. **Tagged records.** DNS records Domainwright creates carry an opaque tenant tag in their comment. Removal only deletes records with the requesting tenant's tag.
6. **Zone activation.** A zone becomes active only when the domain's registrar points at its nameservers, which only the real domain holder can do.

Domainwright cannot know your authorization rules. Always check that the signed-in user may act for `tenantId` before calling it.

## Per-tenant Workers vs. one shared Worker

- **One Worker per tenant**: pass the tenant's Worker as `worker`. Routing checks fail if a hostname serves another tenant's Worker.
- **One shared Worker**: pass the shared Worker. Your Worker maps `request.headers.get('host')` to a tenant using your own data store (KV, D1, or your API). Use the `https` expectation in verification to prove the hostname resolves to the right tenant, for example a health route that returns `x-tenant-id`.

## Supported hostname shapes

| Example                                     | How                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `marketplace-a.com`                         | `domain: 'marketplace-a.com'` (zone created or reused)                                       |
| `www.marketplace-c.com`                     | `dns: { root: false, www: true }` or `{ root: true, www: true }`                             |
| `shop.marketplace-b.com`                    | `dns: { root: false, subdomains: ['shop'] }`, or SaaS custom hostname for tenant-managed DNS |
| `tenant-a.example.com` (your platform zone) | `domain: 'tenant-a.example.com', zone: { name: 'example.com' }`                              |

## Suggested schema

```sql
create table tenant_domains (
  tenant_id    text not null,
  domain       text not null unique,      -- normalized by Domainwright (lowercase, punycode)
  strategy     text not null,
  worker       text not null,
  lifecycle    text not null,             -- pending | registering | configuring | verifying | active | failed | disabled
  state        jsonb,                     -- SetupWorkflowState (no secrets)
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, domain)
);
```

The unique constraint on `domain` is your first line of defence; Domainwright's markers are the second.
