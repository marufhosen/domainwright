# Examples

These files are type-checked with the rest of the repository (`npm run typecheck`). They import from `../src/index.js`; in your application import from your package name instead, for example `domainwright`.

| File                                             | Shows                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [independent-modules.ts](independent-modules.ts) | Using search, Cloudflare zones and DNS, ownership challenges and verification on their own |
| [onboarding.ts](onboarding.ts)                   | A dry run, then onboarding a tenant domain with persisted, resumable state                 |
| [worker-cron.ts](worker-cron.ts)                 | A Cloudflare Worker that re-checks pending domains from a Cron Trigger                     |

Running them performs real provider calls with the credentials you supply. Use test accounts, and note that none of them purchases a domain.
