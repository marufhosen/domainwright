# Runtime compatibility and limitations

## Runtimes

| Module                       | Node.js 20+ | Cloudflare Workers | Notes                                                           |
| ---------------------------- | ----------- | ------------------ | --------------------------------------------------------------- |
| Core client, errors, logging | Yes         | Yes                |                                                                 |
| Cloudflare modules           | Yes         | Yes                | `fetch` only                                                    |
| name.com adapter             | Yes         | Yes                | `fetch` + `btoa`                                                |
| Ownership challenges         | Yes         | Yes                | Web Crypto HMAC (`crypto.subtle`)                               |
| Verification (DNS)           | Yes         | Yes                | DNS-over-HTTPS; Workers have no raw DNS sockets                 |
| Verification (HTTPS probe)   | Yes         | Yes                | See the subrequest note below                                   |
| Workflows                    | Yes         | Yes                | Long `waitForReady` polling is better done from a scheduled job |

The source uses only `fetch`, `Request`/`Response`/`Headers`, `URL`, `URLSearchParams`, `AbortController`, `TextEncoder`, `btoa`, `crypto.subtle`, `crypto.randomUUID` and timers. Lint rules forbid `node:` imports, `Buffer` and `process` in `src/`, and `npm run test:workers` executes the built package inside workerd (the Workers runtime) through Miniflare.

Other runtimes with these Web APIs (Deno, Bun) should work but are not tested.

### Workers-specific notes

- **Subrequest limits.** Each provider call and DNS lookup is a subrequest. A full verification of two hostnames makes roughly 15 to 25 subrequests; resume many domains from a Cron Trigger or Queue in small batches.
- **CPU time.** Polling sleeps without using CPU, but `waitForReady` keeps the invocation alive. Prefer `waitForReady: false` in request handlers and re-check later.
- **Fetching your own zone.** An HTTPS probe from a Worker to a hostname routed to the same Worker is a normal subrequest. If your Worker blocks unknown hosts, allow the health path for domains that are still onboarding.

## Known limitations

- **One registrar adapter (name.com).** Others can be added through `RegistrarAdapter`. Only standard and registry-premium registrations; no transfers, aftermarket or backorders.
- **Nameserver automation only for domains in your registrar account.** Otherwise Domainwright returns instructions.
- **No DNSSEC management.** Disable DNSSEC at the registrar before delegating; re-enable it with Cloudflare afterwards.
- **Cloudflare for SaaS setup is not automated.** Fallback origin, the SaaS zone itself and the `*/*` Worker route are one-time platform configuration. Domainwright verifies the route.
- **Apex domains on SaaS custom hostnames** need CNAME flattening or ALIAS records at the tenant's DNS provider, or Cloudflare's apex proxying (an Enterprise feature). Domainwright reports what it observes but cannot verify flattened apex records by name.
- **Write permissions cannot be pre-checked.** `checkAccess` probes reads; a missing write permission appears as `PERMISSION_DENIED` when the operation runs.
- **Public DNS caching.** Results depend on the resolver cache and record TTLs.
- **Zone types.** Only `full` zones are used by the workflow. `partial` (CNAME setup) zones can be created with `zones.create({ type: 'partial' })` but are not orchestrated.
- **Cloudflare error codes.** Errors are classified mainly by HTTP status, plus a few documented codes (`1061` zone exists, `81053`/`81057` record conflicts, `9109` permission, `10000` authentication, `7003` not found).
- **Not yet validated against live Cloudflare and name.com accounts.** The API shapes follow the official documentation and the official Cloudflare TypeScript SDK types; the opt-in sandbox suite (`npm run test:sandbox`) is the way to validate against real accounts before production use.
