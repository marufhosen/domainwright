# API reference

This page lists every public export by entry point. Behaviour and examples are in the [module guide](modules.md), [workflows](workflows.md), [verification](verification.md) and [errors](errors.md). The TypeScript declarations shipped in `dist/` are the source of truth for every field.

Replace `@your-scope/domainpilot` with your package name (see [CONTRIBUTING.md](../CONTRIBUTING.md#releasing)).

| Entry point                                  | Contents                                                           |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `@your-scope/domainpilot`                    | Everything below, plus the `DomainPilot` client                    |
| `@your-scope/domainpilot/cloudflare`         | `CloudflareClient` and its modules                                 |
| `@your-scope/domainpilot/registrars`         | `RegistrarAdapter` types and `NameComRegistrar`                    |
| `@your-scope/domainpilot/registrars/namecom` | `NameComRegistrar`, `NameComConfig`                                |
| `@your-scope/domainpilot/verification`       | `DomainVerifier`, `DohResolver`, `probeHttps`, `OwnershipModule`   |
| `@your-scope/domainpilot/workflows`          | Workflow functions and state types                                 |
| `@your-scope/domainpilot/errors`             | Error classes, `ErrorCode`, `isDomainPilotError`, `serializeError` |

Every method that calls a provider accepts an optional `signal: AbortSignal` (in its input object or a trailing `options` argument).

## `DomainPilot`

```ts
new DomainPilot(config: DomainPilotConfig)
```

| Config field | Type                                                                        | Notes                                                           |
| ------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `cloudflare` | `{ apiToken: string; accountId: string; baseUrl?: string }`                 | Needed for zones, DNS, Workers, verification and workflows      |
| `registrar`  | `NameComConfig \| RegistrarAdapter`                                         | Needed for search and registration                              |
| `ownership`  | `{ secret: string; recordPrefix?: string }`                                 | Secret of at least 32 characters; needed for `tenantId` options |
| `http`       | `{ fetch?; timeoutMs?; retry?: Partial<RetryPolicy> \| false; userAgent? }` | Shared transport                                                |
| `dns`        | `{ resolver?: DnsResolver; dohUrl?: string }`                               | Public resolver for verification                                |
| `probeFetch` | `FetchLike`                                                                 | fetch used for HTTPS probes                                     |
| `logger`     | `Logger`                                                                    | Receives redacted structured logs                               |

At least one of `cloudflare` or `registrar` is required. The constructor validates configuration and makes no network calls.

| Member                                          | Type                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `domains`                                       | `DomainsModule`                                                     |
| `workflows.setupCustomDomain(input)`            | `Promise<SetupCustomDomainResult>`                                  |
| `workflows.getStatus(input: VerifyDomainInput)` | `Promise<DomainStatusResult>`                                       |
| `workflows.removeCustomDomain(input)`           | `Promise<RemoveCustomDomainResult>`                                 |
| `cloudflare`                                    | `CloudflareClient` (throws `CONFIGURATION_ERROR` if not configured) |
| `registrar`                                     | `RegistrarAdapter` (throws if not configured)                       |
| `ownership`                                     | `OwnershipModule` (throws if not configured)                        |
| `verifier`                                      | `DomainVerifier`                                                    |
| `verify(input: VerifyDomainInput)`              | `Promise<VerificationReport>`                                       |

## `DomainsModule` (`client.domains`)

| Method                                       | Returns                    | Notes                                                                                              |
| -------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `search(input: SearchDomainsInput)`          | `SearchDomainsResult`      | `keyword` + `tlds` and/or `domains`; `includeSuggestions`, `confirmSuggestions`, `suggestionLimit` |
| `check(domains: string[], options?)`         | `AvailabilityResult[]`     | Real-time availability                                                                             |
| `purchase(input: PurchaseDomainInput)`       | `PurchaseDomainResult`     | Requires `maxPrice`; never retried; see safeguards in [modules](modules.md#domain-registration)    |
| `getRegistration(domain, options?)`          | `RegisteredDomain \| null` | `null` when not in the registrar account                                                           |
| `renew(input: RenewDomainInput)`             | `PurchaseDomainResult`     | Requires `maxPrice`                                                                                |
| `setNameservers(input: SetNameserversInput)` | `RegisteredDomain`         | Requires `confirm: true`                                                                           |
| `verify(input: VerifyDomainInput)`           | `VerificationReport`       | Same as `client.verify`                                                                            |

`DomainSearch` and `DomainRegistration` are the classes behind these methods and are exported for advanced composition.

## `CloudflareClient`

```ts
new CloudflareClient(config: CloudflareConfig, options?: { http?: HttpClient | HttpOptions; logger?: Logger })
```

| Member                                             | Methods                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (client)                                           | `verifyToken(options?)` → `{ active, status }`; `checkAccess(options?)` → `AccessReport`                                                                                                                                                                                                                 |
| `zones: ZonesModule`                               | `find(domain)`, `get(zoneId)`, `findForHostname(hostname)`, `create(CreateZoneInput)` → `CreateZoneResult` (reuses an existing zone), `getNameservers(zoneIdOrDomain)`, `triggerActivationCheck(zoneId)`, `waitForActive(zoneId, PollOptions)`, `delete({ zoneId, confirm })`, `resolve(zoneIdOrDomain)` |
| `dns: DnsModule`                                   | `list(ListDnsRecordsInput)`, `get({ zone, recordId })`, `create(CreateDnsRecordInput)` → `CreateDnsRecordResult` (no duplicates, conflict detection), `update(UpdateDnsRecordInput)`, `delete({ zone, recordId, confirm })`                                                                              |
| `workers.customDomains: WorkerCustomDomainsModule` | `list(filter?)`, `findByHostname(hostname)`, `get(domainId)`, `attach(AttachCustomDomainInput)` (refuses to re-point unless `allowReassign`), `detach({ domainId, confirm })`                                                                                                                            |
| `workers.routes: WorkerRoutesModule`               | `list(zoneId)`, `create(CreateRouteInput)`, `delete({ zoneId, routeId, confirm })`                                                                                                                                                                                                                       |
| `customHostnames: CustomHostnamesModule`           | `find(zoneId, hostname)`, `get(zoneId, id)`, `create(CreateCustomHostnameInput)`, `delete({ zoneId, customHostnameId, confirm })`                                                                                                                                                                        |
| `certificates: CertificatesModule`                 | `list(zoneId)`, `statusFor(zoneId, hostname)` → `HostnameCertificateStatus`                                                                                                                                                                                                                              |

Helpers: `nameserverInstructions(zone)`, `buildMarker`, `parseMarker`, `sameRecord`, `validateRecord`, `validateRoutePattern`, `routeMatchesHostname`, `certificateCovers`, `certificateReadiness`, `validateCloudflareConfig`.

## Registrars

`RegistrarAdapter` is the interface every registrar implements:

| Member                                              | Notes                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`, `displayName`                                 | Identifiers                                                                                                                 |
| `capabilities: RegistrarCapabilities`               | `checkAvailability`, `suggestions`, `pricing`, `register`, `idempotentRegistration`, `renew`, `getDomain`, `setNameservers` |
| `checkAvailability(domains, options?)`              | `AvailabilityResult[]`                                                                                                      |
| `suggest?(keyword, tlds, options?)`                 | `AvailabilityResult[]`; optional                                                                                            |
| `getPricing?(domain, years, options?)`              | `DomainPricing`                                                                                                             |
| `register?(request: RegistrationRequest, options?)` | `RegistrationResult`; must not retry                                                                                        |
| `renew?(request: RenewalRequest)`                   | `RegistrationResult`                                                                                                        |
| `getDomain?(domain, options?)`                      | `RegisteredDomain \| null`                                                                                                  |
| `setNameservers?(domain, nameservers, options?)`    | `RegisteredDomain`                                                                                                          |

`NameComRegistrar` implements every capability. Configuration: `{ provider: 'namecom', username, apiToken, environment: 'production' | 'sandbox', baseUrl? }`. See [registrars](registrars.md).

## Ownership (`OwnershipModule`)

| Method                                                              | Returns                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `createChallenge({ hostname, tenantId })`                           | `OwnershipChallenge`: `{ hostname, tenantId, record: { type: 'TXT', name, content }, instructions }`   |
| `verifyChallenge({ hostname, tenantId, signal? })`                  | `OwnershipVerificationResult` (`passed`, `pending`, `failed`, `error`)                                 |
| `publishedChallenges(hostname, { signal? })`                        | `{ status: 'ok' \| 'error', record, values }`: challenge values for any tenant published in public DNS |
| `token(hostname, tenantId)`                                         | Tenant-bound token                                                                                     |
| `tenantTag(tenantId)`                                               | Opaque tag stored in DNS record comments                                                               |
| `isChallengeValue(content)`, `matches(content, hostname, tenantId)` | Helpers                                                                                                |

## Verification

| Export                                                             | Notes                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DomainVerifier`                                                   | `verify(VerifyDomainInput)` → `VerificationReport`                                                                                                                             |
| `VerifyDomainInput`                                                | `domain`, `hostnames?`, `zone?`, `tenantId?`, `routing?: RoutingSpec`, `worker?`, `https?: HttpsExpectation \| false`, `checks?`, `waitForReady?`, `timeoutMs?`, `intervalMs?` |
| `VerificationReport`                                               | `verified`, `summary` (`verified` / `pending` / `failed` / `error`), `checks`, `errors`, `outstandingActions`, `checkedAt`, `attempts`, `timedOut`                             |
| `DohResolver`, `createDohResolver`, `DEFAULT_DOH_URL`, `decodeTxt` | DNS-over-HTTPS                                                                                                                                                                 |
| `probeHttps(fetch, hostname, expectation?)`                        | HTTPS reachability probe                                                                                                                                                       |

## Workflows

| Export                                                            | Notes                                                                                                                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setupCustomDomain(deps, input)`                                  | Same as `client.workflows.setupCustomDomain`                                                                                                                           |
| `getDomainStatus(deps, input)`                                    | Same as `client.workflows.getStatus`                                                                                                                                   |
| `removeCustomDomain(deps, input)`                                 | Same as `client.workflows.removeCustomDomain`                                                                                                                          |
| `deriveLifecycle`, `lifecycleFromVerification`, `selectHostnames` | Helpers used by the workflows                                                                                                                                          |
| `SetupCustomDomainInput`                                          | `domain`, `tenantId?`, `worker`, `routing?`, `dns?`, `zone?`, `registration?`, `nameservers?`, `reassign?`, `verification?`, `dryRun?`, `resumeFrom?`, `onCheckpoint?` |
| `SetupCustomDomainResult`                                         | `lifecycle`, `ready`, `dryRun`, `steps`, `verification?`, `outstandingActions`, `errors`, `state`                                                                      |
| `SetupWorkflowState`                                              | Serializable, secret-free state (`version: 1`) for `resumeFrom`                                                                                                        |
| `RemoveCustomDomainInput`                                         | `domain`, `tenantId?`, `worker?`, `routing?`, `dns?`, `zone?`, `deleteZone?`, `confirm?`, `dryRun?`                                                                    |
| `RemoveCustomDomainResult`                                        | `lifecycle` (`disabled`, `failed` or `unchanged`), `steps`, `removed`, `retained`, `errors`                                                                            |

Use the methods on `client.workflows` unless you are wiring dependencies yourself.

## Errors

`DomainPilotError` has `code: ErrorCode`, `retryable`, `provider`, `status`, `providerErrors`, `details` and `toJSON()`. Subclasses: `ValidationError`, `ConfigurationError`, `ProviderError`, `UnsupportedOperationError`, `ConfirmationRequiredError`, `TenantConflictError`, `PurchaseError`. Helpers: `isDomainPilotError(error, code?)`, `serializeError(error)`. Codes are listed in [errors](errors.md).

## Shared types and utilities

`DomainLifecycleState`, `RoutingStrategy`, `WorkerTarget`, `resolveWorkerService`, `CheckId`, `CheckStatus`, `CheckResult`, `OutstandingAction`, `RequestOptions`, `HttpClient`, `HttpOptions`, `FetchLike`, `RetryPolicy`, `Logger`, `LogLevel`, `LogFields`, `noopLogger`, `createConsoleLogger`, `redact`, `normalizeHostname`, `isWithinZone`, `poll`, `PollOptions`, `PollResult`.
