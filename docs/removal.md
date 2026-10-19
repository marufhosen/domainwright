# Removing a domain safely

```ts
// Preview first.
const plan = await client.workflows.removeCustomDomain({
  domain: 'marketplace-a.com',
  tenantId: 'tenant_123',
  worker: { name: 'property-source', environment: 'production' },
  dns: { root: true, www: true },
  dryRun: true,
});
plan.removed; // what would be removed
plan.retained; // what would be left, and why

// Then remove.
const result = await client.workflows.removeCustomDomain({
  domain: 'marketplace-a.com',
  tenantId: 'tenant_123',
  worker: { name: 'property-source', environment: 'production' },
  dns: { root: true, www: true },
  confirm: true,
});
result.lifecycle; // 'disabled' when every step succeeded
```

## What is removed

| Step      | Removed                                                                                                                                       | Kept                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `tenant`  | (check only) the ownership marker (SaaS: the challenge TXT in public DNS) must belong to `tenantId`; one for another tenant stops the removal |                                                                                 |
| `routing` | Workers Custom Domains for the hostnames that point at `worker`; routes exactly `hostname/*` running `worker`; SaaS custom hostnames          | Attachments and routes for other Workers; wildcard routes                       |
| `dns`     | Records at the hostnames and the `_domainwright` marker that carry this tenant's Domainwright marker (A, AAAA, CNAME, TXT)                    | Every record Domainwright did not create, and records created for other tenants |
| `zone`    | Only with `deleteZone: true`, only for an apex zone, and only when no unmanaged records remain                                                | Shared parent zones are never deleted                                           |

Rules:

- `confirm: true` is required unless `dryRun: true`.
- Pass `worker` so only routing for that Worker is removed.
- When a domain has an ownership marker, `tenantId` is required and must match.
- For SaaS custom hostnames the same rule applies to the tenant's challenge TXT (`_domainwright.<hostname>`) in public DNS. If the tenant has since deleted the challenge there is nothing to compare, and removal proceeds. If the lookup fails, removal stops with a retryable `NETWORK_ERROR`.
- The registrar registration is never cancelled. Domains stay in your registrar account until they expire; disable auto-renew with your registrar if you no longer need them.
- Nameservers are never changed back. If the tenant leaves Cloudflare, they change nameservers at their registrar.

## Reassigning a domain to another tenant

Removal followed by onboarding for the new tenant is the clearest path. To move directly, run `setupCustomDomain` for the new tenant with `reassign: { allowed: true }` after your application has confirmed the transfer is authorized; Domainwright replaces the previous tenant's marker and re-points the hostnames to the new Worker.
