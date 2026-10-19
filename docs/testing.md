# Testing

Domainwright has four test layers. Only the first two run by default, and none of the default tests touch a real provider.

| Command                 | What it runs                                                                                        | Network                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `npm test`              | Unit tests (`test/unit`) and workflow integration tests (`test/integration`)                        | None: every provider is an in-memory fake |
| `npm run test:workers`  | Builds the package and runs a smoke Worker in workerd through Miniflare (`test/workers`)            | None: provider calls go to a fake fetch   |
| `npm run test:sandbox`  | Opt-in live tests against a name.com sandbox account and a Cloudflare test account (`test/sandbox`) | Yes, only when credentials are set        |
| `npm run check:package` | Builds, lints the package with publint and lists what `npm pack` would publish                      | None                                      |

## Mocked tests

`test/fakes` contains stateful fakes of the Cloudflare API (`FakeCloudflare`), the name.com API (`FakeNameCom`), public DNS and HTTPS. `createTestEnv()` routes a fake `fetch` to them, so tests exercise the real HTTP, retry and parsing code. Faults are injected per request (`inject()`, `nextCreate`) to cover rate limits, timeouts, races, payment failures and unknown purchase outcomes.

Ordinary tests never purchase domains and never read credentials from the environment.

## Sandbox tests

Sandbox tests are skipped unless their variables are set. Use dedicated test credentials, never production ones.

```sh
# name.com sandbox (https://api.dev.name.com); usernames end in "-test"
NAMECOM_SANDBOX_USERNAME=acme-test NAMECOM_SANDBOX_TOKEN=... npm run test:sandbox

# also run the sandbox purchase test (uses sandbox test credit; sandbox domains cannot be deleted)
DOMAINWRIGHT_SANDBOX_ALLOW_PURCHASE=1 NAMECOM_SANDBOX_USERNAME=acme-test NAMECOM_SANDBOX_TOKEN=... npm run test:sandbox

# Cloudflare test account with a throwaway zone; creates and deletes one TXT record
CLOUDFLARE_TEST_API_TOKEN=... CLOUDFLARE_TEST_ACCOUNT_ID=... CLOUDFLARE_TEST_ZONE=test.example.com npm run test:sandbox
```

The name.com sandbox client is always created with `environment: 'sandbox'`, which only accepts `-test` usernames, so a production account cannot be used by mistake.

CI does not run sandbox tests. If you add them to CI, store the credentials as repository secrets and run them on a protected branch only.

## Workers runtime test

`test/workers/smoke.worker.ts` imports the built package, creates a client and runs IDN normalization, zone creation, an ownership challenge (Web Crypto HMAC) and a DNS-over-HTTPS lookup against an in-Worker mock inside workerd. It catches accidental use of Node.js-only APIs that unit tests in Node.js would not.
