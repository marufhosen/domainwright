# Nameserver setup

For `custom-domain` and `route` strategies on an apex domain, the domain must use the two nameservers Cloudflare assigned to its zone. Until then the zone stays `pending`, nothing resolves through Cloudflare and no certificate is issued.

## Getting the nameservers

```ts
const zone = await client.cloudflare.zones.create({ domain: 'example.com' });
zone.nameservers; // e.g. ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']
zone.nameserverInstructions?.instructions; // ready-to-show text

// or later
const ns = await client.cloudflare.zones.getNameservers('example.com');
```

The workflow returns the same information as an `update-nameservers` outstanding action, including `automatable: true` when Domainwright could make the change itself.

## Automatic change (domains in your registrar account)

When the domain is in the configured registrar account (for example, bought through `domains.purchase`) and the adapter supports it, Domainwright can set the nameservers, but only when you authorize it:

```ts
await client.workflows.setupCustomDomain({ ...input, nameservers: { updateAtRegistrar: true } });
// or directly
await client.domains.setNameservers({ domain: 'example.com', nameservers: zone.nameservers, confirm: true });
```

It then asks Cloudflare to re-run the activation check. name.com rejects nameserver changes while a registry lock such as `clientUpdateProhibited` is set; the error explains which lock to remove.

## Manual change (any other registrar)

Show the tenant these steps (the `instructions` text says the same):

1. Sign in to the registrar where the domain was bought.
2. Find the nameserver (or "DNS servers") setting for the domain and choose custom nameservers.
3. Replace all existing nameservers with exactly the two Cloudflare nameservers.
4. Turn off DNSSEC at the registrar until the zone is active (re-enable it with Cloudflare's DS record afterwards).
5. Save. Delegation usually completes within a few hours and can take up to 24 hours.

Before switching, copy any records the domain still needs (mail MX, SPF/DKIM TXT, verification records) into the Cloudflare zone, for example with `client.cloudflare.dns.create`.

## Watching for activation

- `client.cloudflare.zones.waitForActive(zoneId, { timeoutMs, intervalMs })` polls the zone.
- `client.domains.verify` reports the `nameservers` check (registrar and public DNS comparison) and `zone-activation` separately, so you can tell "the tenant has not changed anything yet" from "the change is visible, Cloudflare has not activated yet".
- A zone that later shows `moved` means the domain stopped using Cloudflare's nameservers; verification reports it as `failed`.
