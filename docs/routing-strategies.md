# Routing strategies

A Cloudflare zone, a DNS record and a deployed Worker are three separate things. Traffic reaches the Worker only when a routing mechanism connects the hostname to it, and each mechanism has different prerequisites. DomainPilot makes you choose one and verifies the one you chose.

## `custom-domain`: Workers Custom Domains (default)

API: `PUT /accounts/{account_id}/workers/domains` with `{ hostname, service, zone_id }`.

- The hostname's zone must be in the same Cloudflare account as the Worker.
- Cloudflare creates the DNS record and issues a certificate for the hostname. Do not create your own A/AAAA/CNAME for it; existing ones conflict, and DomainPilot reports them as `resolve-dns-conflict` actions instead of deleting them.
- Works for apex domains, `www` and any subdomain.
- The Worker receives every path on the hostname.
- Cloudflare's `environment` field on this API is deprecated; DomainPilot targets the Worker's service name (`name-environment` for Wrangler environments).

Best for: platforms that host tenant zones in their own account (the tenant changes nameservers to Cloudflare), and tenant subdomains of the platform zone (`tenant-a.example.com`).

## `route`: Workers Routes

API: `POST /zones/{zone_id}/workers/routes` with `{ pattern, script }`.

- The zone must be in the account.
- A route only runs for proxied traffic, so the hostname needs a proxied A, AAAA or CNAME record. DomainPilot reuses an existing proxied record or creates an originless `AAAA 100::` record. An existing unproxied record is reported as a conflict, never modified.
- DomainPilot creates exactly `hostname/*`. Wildcard routes you created yourself are verified but never removed.
- Certificates come from the zone's Universal SSL (apex and one level of subdomain) or your Advanced certificates.

Best for: setups that need path-based routing or an origin behind some paths.

## `saas-custom-hostname`: Cloudflare for SaaS

API: `POST /zones/{saas_zone_id}/custom_hostnames` on the platform's own zone.

- Requires Cloudflare for SaaS on the platform zone, a fallback origin, and a Worker route on that zone that matches tenant hostnames (typically `*/*`). That one-time setup is not automated; DomainPilot verifies the route and reports a `configure-worker-route` action if it is missing.
- The tenant keeps DNS at their own provider and adds `CNAME <hostname> -> <cnameTarget>`. Apex hostnames need CNAME flattening or an ALIAS/ANAME record at the tenant's DNS provider.
- With `tenantId`, DomainPilot creates the custom hostname only after the tenant publishes the tenant-bound `_domainpilot` TXT record. This prevents another tenant from registering the hostname on your SaaS zone first and capturing its traffic.
- Certificate validation defaults to the HTTP method, which completes once the CNAME is in place. Cloudflare's own `ownership_verification` TXT is returned as an optional pre-validation action.

Best for: tenants who will not move their nameservers.

## Choosing

| Question                                                                          | Answer | Strategy                                             |
| --------------------------------------------------------------------------------- | ------ | ---------------------------------------------------- |
| Will the tenant point nameservers at Cloudflare (or did you register the domain)? | Yes    | `custom-domain`                                      |
| Is it a subdomain of your platform zone?                                          | Yes    | `custom-domain` with `zone: { name: 'example.com' }` |
| Do you need path-level routing or an origin?                                      | Yes    | `route`                                              |
| Must the tenant keep DNS where it is?                                             | Yes    | `saas-custom-hostname`                               |
