# Next.js and Cloudflare Workers integration

This guide adds tenant custom domains to a Next.js SaaS application deployed on Cloudflare Workers (for example with the OpenNext Cloudflare adapter). Domainwright runs on the server side only: in route handlers, server actions, a separate Worker, or a queue consumer. Never ship provider credentials to the browser.

For a Next.js app on Node.js (Vercel or self-hosted), or a React front end with a separate backend, start with [Using Domainwright with React and Next.js](react-and-nextjs.md).

## 1. Install and store secrets

```sh
npm install domainwright
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put DOMAINWRIGHT_OWNERSHIP_SECRET
# only if you sell domains
npx wrangler secret put NAMECOM_USERNAME
npx wrangler secret put NAMECOM_API_TOKEN
```

## 2. Create the client per request

Creating a client is cheap and makes no network calls, so build it from the request's environment:

```ts
// lib/domains.ts
import { Domainwright } from 'domainwright';

export interface DomainEnv {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  DOMAINWRIGHT_OWNERSHIP_SECRET: string;
}

export function domainClient(env: DomainEnv): Domainwright {
  return new Domainwright({
    cloudflare: { apiToken: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID },
    ownership: { secret: env.DOMAINWRIGHT_OWNERSHIP_SECRET },
  });
}
```

With OpenNext, read bindings with `getCloudflareContext()` from `@opennextjs/cloudflare`:

```ts
import { getCloudflareContext } from '@opennextjs/cloudflare';
const { env } = getCloudflareContext();
const client = domainClient(env as unknown as DomainEnv);
```

## 3. Connect a domain from a route handler

```ts
// app/api/tenants/[tenantId]/domains/route.ts
import { NextResponse } from 'next/server';
import { isDomainwrightError } from 'domainwright';

export async function POST(request: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  await assertUserCanManageTenant(request, tenantId); // your authorization
  const { domain } = (await request.json()) as { domain: string };

  const client = domainClient(getEnv());
  try {
    const result = await client.workflows.setupCustomDomain({
      domain,
      tenantId,
      worker: { name: 'my-saas', environment: 'production' },
      dns: { root: true, www: true },
      onCheckpoint: (state) => db.tenantDomains.saveState(tenantId, state.domain, state),
    });
    await db.tenantDomains.upsert({
      tenantId,
      domain: result.domain,
      lifecycle: result.lifecycle,
      state: result.state,
    });
    return NextResponse.json({ lifecycle: result.lifecycle, ready: result.ready, actions: result.outstandingActions });
  } catch (error) {
    if (isDomainwrightError(error, 'VALIDATION_ERROR'))
      return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
```

Return `outstandingActions` to the UI: show the nameservers for `update-nameservers`, or the record for `add-dns-record`.

## 4. Re-check pending domains on a schedule

Do not hold a request open while DNS propagates. Add a Cron Trigger (or a Queue) to the Worker:

```ts
// worker entry, scheduled handler
export default {
  async scheduled(_event: ScheduledEvent, env: DomainEnv & AppEnv) {
    const client = domainClient(env);
    for (const row of await db.tenantDomains.listByLifecycle(['configuring', 'verifying', 'registering'])) {
      const result = await client.workflows.setupCustomDomain({
        domain: row.domain,
        tenantId: row.tenantId,
        worker: { name: 'my-saas', environment: 'production' },
        dns: { root: true, www: true },
        resumeFrom: row.state,
      });
      await db.tenantDomains.upsert({ ...row, lifecycle: result.lifecycle, state: result.state });
    }
  },
};
```

Workers have a per-invocation subrequest limit, so process a bounded batch per run.

## 5. Resolve the tenant from the hostname in your app

Domainwright routes the hostname to your Worker; your application decides which tenant it is. In Next.js middleware:

```ts
// middleware.ts
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const host = request.headers.get('host')?.toLowerCase() ?? '';
  const mapping = await lookupTenantByHost(host); // KV / D1 / API: { tenantId, lifecycle }, written when onboarding starts
  if (!mapping) return new NextResponse('Unknown domain', { status: 404 });
  const isHealthCheck = request.nextUrl.pathname === '/.well-known/domainwright-health';
  // Serve tenant content only once the domain is active; the health route must work earlier so verification can pass.
  if (mapping.lifecycle !== 'active' && !isHealthCheck)
    return new NextResponse('Domain is being set up', { status: 503 });
  const tenantId = mapping.tenantId;
  const headers = new Headers(request.headers);
  headers.set('x-tenant-id', tenantId);
  return NextResponse.next({ request: { headers } });
}
```

Write the host to that lookup table when onboarding starts (your unique constraint on `domain` decides who gets it), update its lifecycle from each workflow result, and delete it when the domain is removed or reassigned.

## 6. Prove the right tenant is served

Expose a tiny health route and use it in verification:

```ts
// app/.well-known/domainwright-health/route.ts
export function GET(request: Request) {
  return new Response('ok', { headers: { 'x-tenant-id': request.headers.get('x-tenant-id') ?? '' } });
}
```

```ts
verification: { https: { path: '/.well-known/domainwright-health', status: [200], header: { name: 'x-tenant-id', value: tenantId } } }
```

## 7. Remove a domain

```ts
await client.workflows.removeCustomDomain({
  domain,
  tenantId,
  worker: { name: 'my-saas', environment: 'production' },
  dns: { root: true, www: true },
  confirm: true,
});
await db.tenantDomains.markDisabled(tenantId, domain);
```
