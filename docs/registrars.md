# Registrars

## Why name.com is the first adapter

Before choosing, the registrar APIs were checked against what the SDK needs: real-time availability, suggestions, pricing (including premium names), registration, safe retries, renewal, domain details and nameserver changes, plus a way to test purchases without spending money.

| Registrar API            | Search / check                                      | Register                      | Idempotent registration                       | Nameservers             | Sandbox                               | Notes                                                                 |
| ------------------------ | --------------------------------------------------- | ----------------------------- | --------------------------------------------- | ----------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| **name.com Core API**    | Yes (`domains:checkAvailability`, `domains:search`) | Yes (`POST /core/v1/domains`) | Yes (`X-Idempotency-Key`, replays for 1 hour) | Yes (`:setNameservers`) | Yes (`api.dev.name.com`, test credit) | JSON over HTTPS with Basic auth; works with `fetch` everywhere        |
| Cloudflare Registrar API | Yes (beta)                                          | Yes (beta, subset of TLDs)    | Not documented                                | Not documented          | Yes (beta)                            | Renewals, transfers and contact updates are not available via API yet |

name.com covers the full lifecycle today and can be exercised end to end in its sandbox, so it is the first adapter. Cloudflare Registrar is the natural next adapter once its API leaves beta.

## name.com adapter

```ts
registrar: {
  provider: 'namecom',
  username: 'acme-test', // sandbox usernames end in "-test"
  apiToken: env.NAMECOM_API_TOKEN,
  environment: 'sandbox', // or 'production'
}
```

| DomainPilot                               | name.com endpoint                                             |
| ----------------------------------------- | ------------------------------------------------------------- |
| `domains.check`, `domains.search` (exact) | `POST /core/v1/domains:checkAvailability` (50 names per call) |
| `domains.search` (`includeSuggestions`)   | `POST /core/v1/domains:search`                                |
| price quotes in `purchase` / `renew`      | `GET /core/v1/domains/{domain}:getPricing?years=`             |
| `domains.purchase`                        | `POST /core/v1/domains` with `X-Idempotency-Key`              |
| `domains.renew`                           | `POST /core/v1/domains/{domain}:renew`                        |
| `domains.getRegistration`                 | `GET /core/v1/domains/{domain}`                               |
| `domains.setNameservers`                  | `POST /core/v1/domains/{domain}:setNameservers`               |

Requirements and limitations:

- The account must be funded (name.com bills from account credit); a failed charge is `PAYMENT_FAILED`.
- Prices are in USD. `maxPrice` must use `USD`.
- Without `contacts`, the account's default contacts are used. Some registries require contact verification; name.com emails the registrant, and the domain may be suspended if it is not completed.
- Some TLDs need registry-specific fields (`tldRequirements`), for example `.se` identity numbers. Pass them as `tldRequirements` to `domains.purchase`.
- Only standard and registry-premium registrations are supported. Aftermarket, expiring and backorder purchase types are reported as `unavailable` for registration.
- Rate limit: 20 requests per second; 429 responses are retried after `X-RateLimit-Reset`.
- Sandbox: availability and pricing are test data, some TLDs are missing, domains created there cannot be deleted, and DNS changes do not resolve publicly.

## Writing an adapter

Implement `RegistrarAdapter` and declare only what the provider really supports. DomainPilot checks `capabilities` before every call and throws `UNSUPPORTED_OPERATION` instead of guessing.

```ts
import type { RegistrarAdapter } from '@your-scope/domainpilot/registrars';
import { DomainPilot } from '@your-scope/domainpilot';

class MyRegistrar implements RegistrarAdapter {
  readonly id = 'my-registrar';
  readonly displayName = 'My Registrar';
  readonly capabilities = {
    checkAvailability: true,
    suggestions: false,
    pricing: true,
    register: true,
    idempotentRegistration: false,
    renew: false,
    getDomain: true,
    setNameservers: false,
  };
  async checkAvailability(domains: string[]) { /* ... */ return []; }
  async getPricing(domain: string, years: number) { /* ... */ }
  async register(request) { /* never retry; throw PurchaseError('PURCHASE_OUTCOME_UNKNOWN', ...) when unsure */ }
  async getDomain(domain: string) { /* return null when not in the account */ }
}

const client = new DomainPilot({ registrar: new MyRegistrar(), cloudflare: { ... } });
```

Adapter rules:

- `register` must not retry and must throw `PURCHASE_OUTCOME_UNKNOWN` when the request may have been processed without a response.
- If the provider has no idempotency keys, set `idempotentRegistration: false`; the workflow will then refuse to repeat an unknown purchase and ask for a manual check.
- `checkAvailability` results must set `confirmed: true` only for real-time checks.
- Do not log or return credentials or contact data.
- Keep provider code in its own folder under `src/registrars/`, with mocked tests like `test/unit/registrar.test.ts`.
