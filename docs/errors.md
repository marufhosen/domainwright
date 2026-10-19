# Errors, retries and recovery

## Error classes

Every error is a `DomainPilotError` with a stable `code`, `retryable`, optional `provider`, `status`, `providerErrors` (provider code and message only) and non-sensitive `details`. Subclasses help with `instanceof` checks:

| Class                       | Codes                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValidationError`           | `VALIDATION_ERROR`                                                                                                                                    |
| `ConfigurationError`        | `CONFIGURATION_ERROR`                                                                                                                                 |
| `ProviderError`             | `AUTHENTICATION_FAILED`, `PERMISSION_DENIED`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `PROVIDER_ERROR`, `VALIDATION_ERROR` (provider rejected input) |
| `PurchaseError`             | `DOMAIN_UNAVAILABLE`, `PURCHASE_NOT_AUTHORIZED`, `PAYMENT_FAILED`, `PURCHASE_FAILED`, `PURCHASE_OUTCOME_UNKNOWN`                                      |
| `TenantConflictError`       | `TENANT_CONFLICT`                                                                                                                                     |
| `ConfirmationRequiredError` | `CONFIRMATION_REQUIRED`                                                                                                                               |
| `UnsupportedOperationError` | `UNSUPPORTED_OPERATION`                                                                                                                               |
| `DomainPilotError`          | `TIMEOUT`, `NETWORK_ERROR`, `ABORTED`, `WORKFLOW_STATE_MISMATCH`                                                                                      |

```ts
import { isDomainPilotError, PurchaseError } from '@your-scope/domainpilot';

try {
  await client.domains.purchase({ domain, maxPrice: 20 });
} catch (error) {
  if (error instanceof PurchaseError && error.code === 'PURCHASE_NOT_AUTHORIZED') showPriceTooHigh(error.details);
  else if (isDomainPilotError(error, 'RATE_LIMITED')) retryLater();
  else throw error;
}
```

`error.toJSON()` returns a JSON-safe record; workflow results store errors in this form. Messages and details never contain credentials, request headers or contact data.

## Provider errors vs. verification results

Provider errors are thrown (or, inside workflows, recorded on the failing step). Verification never throws for a misconfiguration: it returns `failed`, `pending` or `error` checks. A check that could not run because a provider call failed is `error`, not `failed`.

## Retries and rate limits

The HTTP layer retries transient failures with exponential backoff and jitter (defaults: 4 attempts, 500 ms initial, 30 s cap):

- `GET`, `PUT`, `DELETE` and requests marked idempotent: network errors, timeouts, 408, 429, 500, 502, 503, 504.
- `POST` and `PATCH`: only 429, which means the server rejected the request without processing it.
- `Retry-After` and `X-RateLimit-Reset` headers are honoured (capped at `maxDelayMs`).

```ts
new DomainPilot({ ..., http: { timeoutMs: 15_000, retry: { maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 10_000 } } });
new DomainPilot({ ..., http: { retry: false } }); // disable
```

Every operation accepts `signal` for cancellation; a cancelled operation throws `ABORTED`.

## Purchases

Purchases are never retried automatically.

| Code                       | Meaning                                                                                                                                 | Recovery                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `PURCHASE_NOT_AUTHORIZED`  | No `maxPrice`, quote above it, premium without `allowPremium`, or no quote available                                                    | Raise the limit deliberately or choose another domain |
| `DOMAIN_UNAVAILABLE`       | Not available, or availability could not be confirmed (`retryable: true`)                                                               | Search again                                          |
| `PAYMENT_FAILED`           | The registrar could not charge the account (HTTP 402)                                                                                   | Fund the account, then retry                          |
| `PURCHASE_FAILED`          | The registrar rejected the request (price mismatch, invalid contact, legal block); `retryable` when pricing was temporarily unavailable | Fix the input                                         |
| `PURCHASE_OUTCOME_UNKNOWN` | A timeout, network failure or 5xx after the request was sent; it may have succeeded                                                     | See below                                             |

For `PURCHASE_OUTCOME_UNKNOWN`, `error.details.idempotencyKey` holds the key that was sent. Recover with either:

```ts
// 1. Check the account first.
const owned = await client.domains.getRegistration(domain);

// 2. Or repeat with the same key; within an hour name.com replays the original result instead of charging again,
//    and DomainPilot short-circuits to 'already-owned' when the domain is already in the account.
await client.domains.purchase({ domain, maxPrice: 20, idempotencyKey: error.details.idempotencyKey as string });
```

The onboarding workflow does this for you on resume.

## Workflow failures and partial completion

A failing step stops the workflow; later steps stay `pending`. `result.errors` lists `{ step, code, message, retryable }`, and `result.lifecycle` is:

- `failed` for non-retryable errors (a conflict, an unauthorized purchase, a permission problem),
- `registering` for an unknown purchase outcome,
- otherwise the phase it was in (`configuring`, `verifying`), so resuming later is the right move.

Resources created before the failure are listed in `result.state.resources` and are reused on resume.
