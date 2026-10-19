# Credentials and permissions

DomainPilot never ships or stores credentials. Your application passes them to the client at construction time; they live in memory only. They are never logged (log fields are redacted), never placed in errors, and never returned in results or workflow state.

## Which features need which credentials

| Feature                                                          | Cloudflare token | Registrar credentials                                                      | Ownership secret                                             |
| ---------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `domains.search`, `domains.check`                                |                  | Required                                                                   |                                                              |
| `domains.purchase`, `renew`, `getRegistration`, `setNameservers` |                  | Required                                                                   |                                                              |
| `cloudflare.*`                                                   | Required         |                                                                            |                                                              |
| `domains.verify`, `workflows.getStatus`                          | Required         | Optional (adds the registration check and registrar nameserver comparison) | Required when `tenantId` is passed                           |
| `workflows.setupCustomDomain`                                    | Required         | Required only for `registration` or `nameservers.updateAtRegistrar`        | Required when `tenantId` is passed                           |
| `workflows.removeCustomDomain`                                   | Required         |                                                                            | Required when `tenantId` is passed                           |
| Public DNS and HTTPS checks                                      |                  |                                                                            | Uses `https://cloudflare-dns.com/dns-query` (no credentials) |

## Minimum Cloudflare API token permissions

Create an account-scoped or user API token at **Cloudflare dashboard > My Profile (or Manage Account) > API Tokens**. Grant only what you use, and scope zone permissions to the zones (or "All zones from an account") you manage.

| Module / operation                                             | Permission                         |
| -------------------------------------------------------------- | ---------------------------------- |
| `zones.find`, `zones.get`, `zones.getNameservers`              | Zone > Zone > Read                 |
| `zones.create`, `zones.delete`, `zones.triggerActivationCheck` | Zone > Zone > Edit                 |
| `dns.list`, `dns.get`                                          | Zone > DNS > Read                  |
| `dns.create`, `dns.update`, `dns.delete`                       | Zone > DNS > Edit                  |
| `workers.customDomains.*`                                      | Account > Workers Scripts > Edit   |
| `workers.routes.list`                                          | Zone > Workers Routes > Read       |
| `workers.routes.create`, `delete`                              | Zone > Workers Routes > Edit       |
| `customHostnames.*` (Cloudflare for SaaS)                      | Zone > SSL and Certificates > Edit |
| `certificates.list`, `statusFor`                               | Zone > SSL and Certificates > Read |
| `verifyToken`                                                  | none (any valid token)             |

Typical sets:

- **Onboarding with Workers Custom Domains**: Zone:Edit, DNS:Edit, Workers Scripts:Edit, SSL and Certificates:Read.
- **Onboarding with Workers Routes**: Zone:Edit, DNS:Edit, Workers Routes:Edit, SSL and Certificates:Read.
- **Cloudflare for SaaS**: Zone:Read and Workers Routes:Read on the SaaS zone, SSL and Certificates:Edit on the SaaS zone.
- **Read-only status dashboards**: Zone:Read, DNS:Read, Workers Scripts:Read, Workers Routes:Read, SSL and Certificates:Read.

Cloudflare does not let a token list its own permissions, so `client.cloudflare.checkAccess()` probes read access (token validity, zone listing, Workers custom domain listing). Write permissions are confirmed when an operation runs; a missing permission surfaces as a `PERMISSION_DENIED` error.

## name.com credentials

Create API tokens at <https://www.name.com/account/settings/api>. name.com issues separate tokens for production and for the sandbox ("Development/Test Environment").

- Sandbox: `environment: 'sandbox'`, username with the `-test` suffix (for example `acme-test`), sandbox token. Requests go to `https://api.dev.name.com`; the sandbox account has test credit and nothing is charged.
- Production: `environment: 'production'`, your normal username and production token. Requests go to `https://api.name.com` and purchases are charged to the account.

DomainPilot refuses mismatched combinations (a `-test` username in production, or a plain username in the sandbox) so test credentials cannot reach production by accident. `environment` has no default for the same reason.

## Ownership secret

`ownership.secret` (32+ characters) keys the HMAC that derives tenant-bound verification tokens and the opaque tenant tags DomainPilot writes into DNS record comments. Generate it once (for example `openssl rand -base64 48`), store it in your secret manager, and keep it stable: rotating it invalidates published challenges and makes existing markers unrecognizable, which blocks reuse until you pass `zone.adoptExisting` or `reassign`.

## Environment variables

DomainPilot does not read environment variables itself; it is your application that maps them into the configuration. [`.env.example`](../.env.example) lists suggested names. On Cloudflare Workers, store secrets with `wrangler secret put` and read them from `env`; on Node.js, use your secret manager or `process.env`.

## Different credentials per environment

Create one client per credential set:

```ts
const sandboxClient = new DomainPilot({
  cloudflare: { apiToken: env.CF_STAGING_TOKEN, accountId: env.CF_STAGING_ACCOUNT },
  registrar: {
    provider: 'namecom',
    username: env.NAMECOM_TEST_USER,
    apiToken: env.NAMECOM_TEST_TOKEN,
    environment: 'sandbox',
  },
});

const productionClient = new DomainPilot({
  cloudflare: { apiToken: env.CF_PROD_TOKEN, accountId: env.CF_PROD_ACCOUNT },
  registrar: {
    provider: 'namecom',
    username: env.NAMECOM_USER,
    apiToken: env.NAMECOM_TOKEN,
    environment: 'production',
  },
});
```
