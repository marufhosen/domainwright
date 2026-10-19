# Using Domainwright with React and Next.js

Domainwright is a **server-side** library. It holds your Cloudflare, registrar and ownership secrets, so it must never be imported into code that runs in the browser. The pattern for any JavaScript front end:

```
React UI (browser)  ──fetch──▶  your API (server)  ──▶  Domainwright  ──▶  Cloudflare / registrar
```

| You use                                        | Where Domainwright runs                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Next.js (App Router)                           | Route handlers or server actions. This guide.                                                   |
| Next.js on Cloudflare Workers (OpenNext)       | Same, with secrets from Worker bindings. See [the Workers guide](nextjs-cloudflare-workers.md). |
| React SPA (Vite, CRA, React Router)            | Any Node.js 20+ backend (Express, Fastify, Hono, ...) or a Worker. The React part is the same.  |
| Remix / React Router framework mode, SvelteKit | Server loaders and actions, as with Next.js route handlers.                                     |

## 1. Install and configure

```sh
npm install domainwright
npm install server-only # optional: makes the build fail if the client is imported into browser code
```

```sh
# .env.local (never prefix these with NEXT_PUBLIC_)
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
DOMAINWRIGHT_OWNERSHIP_SECRET=... # at least 32 characters; keep it stable
```

Create the client in one server-only module. Construction makes no network calls, so a module-level instance is fine on Node.js:

```ts
// lib/domains.ts
import 'server-only';
import { Domainwright } from 'domainwright';

export const domains = new Domainwright({
  cloudflare: { apiToken: process.env.CLOUDFLARE_API_TOKEN!, accountId: process.env.CLOUDFLARE_ACCOUNT_ID! },
  ownership: { secret: process.env.DOMAINWRIGHT_OWNERSHIP_SECRET! },
});

export const WORKER = { name: 'my-saas', environment: 'production' } as const;
```

## 2. API routes

Two endpoints are enough: one starts onboarding, the other resumes it and returns the current state. The workflow state is plain JSON; store it with the tenant's domain (`db` below stands for your database).

```ts
// app/api/domains/route.ts
import { NextResponse } from 'next/server';
import { isDomainwrightError } from 'domainwright';
import { domains, WORKER } from '@/lib/domains';

export async function POST(request: Request) {
  const tenantId = await requireTenant(request); // your auth: which tenant is this user allowed to manage?
  const { domain } = (await request.json()) as { domain: string };
  try {
    const result = await domains.workflows.setupCustomDomain({
      domain,
      tenantId,
      worker: WORKER,
      dns: { root: true, www: true },
      onCheckpoint: (state) => db.tenantDomains.saveState(tenantId, state.domain, state),
    });
    await db.tenantDomains.saveState(tenantId, result.domain, result.state);
    return NextResponse.json({
      domain: result.domain,
      lifecycle: result.lifecycle,
      ready: result.ready,
      actions: result.outstandingActions,
    });
  } catch (error) {
    if (isDomainwrightError(error, 'VALIDATION_ERROR')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
```

```ts
// app/api/domains/[domain]/refresh/route.ts
import { NextResponse } from 'next/server';
import { domains, WORKER } from '@/lib/domains';

export async function POST(request: Request, { params }: { params: Promise<{ domain: string }> }) {
  const tenantId = await requireTenant(request);
  const { domain } = await params;
  const saved = await db.tenantDomains.getState(tenantId, domain);
  if (!saved) return NextResponse.json({ error: 'Unknown domain' }, { status: 404 });

  // Resuming repeats only cheap lookups, picks up where the last run stopped and never buys twice.
  const result = await domains.workflows.setupCustomDomain({
    domain,
    tenantId,
    worker: WORKER,
    dns: { root: true, www: true },
    resumeFrom: saved,
  });
  await db.tenantDomains.saveState(tenantId, domain, result.state);
  return NextResponse.json({ lifecycle: result.lifecycle, ready: result.ready, actions: result.outstandingActions });
}
```

`result.outstandingActions` is what the tenant (or you) still has to do, for example change nameservers at their registrar or add a DNS record. Each action has a `type`, and every type except `wait` carries human-readable `instructions`.

Prefer a server action? The same call works inside a function marked `'use server'`. Route handlers are shown because a React SPA can call them too.

## 3. React component

The UI submits the domain, shows the outstanding actions and re-checks every 30 seconds until the domain is `active` or `failed`. It only talks to your API.

```tsx
'use client'; // Next.js only; remove in a plain React app

import { useEffect, useState } from 'react';
import type { DomainLifecycleState, OutstandingAction } from 'domainwright'; // types only: nothing is bundled

interface DomainStatus {
  domain: string;
  lifecycle: DomainLifecycleState;
  ready: boolean;
  actions: OutstandingAction[];
}

export function ConnectDomain() {
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<DomainStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const response = await fetch('/api/domains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: input }),
    });
    const body = await response.json();
    if (!response.ok) return setError(body.error ?? 'Could not connect the domain');
    setStatus(body);
  }

  // Re-check while setup is in progress.
  useEffect(() => {
    if (!status || status.lifecycle === 'active' || status.lifecycle === 'failed') return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/domains/${encodeURIComponent(status.domain)}/refresh`, { method: 'POST' });
      if (response.ok) setStatus({ ...status, ...(await response.json()) });
    }, 30_000);
    return () => clearInterval(timer);
  }, [status]);

  if (!status) {
    return (
      <form onSubmit={connect}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="shop.example.com" />
        <button type="submit">Connect domain</button>
        {error && <p role="alert">{error}</p>}
      </form>
    );
  }

  return (
    <section>
      <h2>{status.domain}</h2>
      <p>Status: {status.ready ? 'Live' : status.lifecycle}</p>
      <ul>
        {status.actions.map((action, i) => (
          <li key={i}>
            {action.type === 'update-nameservers' && <>Set nameservers to: {action.nameservers.join(', ')}</>}
            {action.type === 'add-dns-record' && (
              <>
                Add DNS record: <code>{action.record.type}</code> <code>{action.record.name}</code> →{' '}
                <code>{action.record.content}</code>
              </>
            )}
            {action.type === 'wait' && <>Waiting: {action.reason}</>}
            {action.type !== 'update-nameservers' && action.type !== 'add-dns-record' && action.type !== 'wait' && (
              <>{action.instructions}</>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

In a plain React app (Vite, CRA), use the same component without `'use client'`, and point the `fetch` calls at your backend. The backend code is the body of the route handlers above, inside Express, Fastify or Hono handlers.

## 4. Going to production

- **Check on a schedule, not only from the browser.** DNS and certificates can take hours, and the tenant may close the tab. Resume pending domains from a cron job or queue as well. See [Re-check pending domains on a schedule](nextjs-cloudflare-workers.md#4-re-check-pending-domains-on-a-schedule).
- **Map hostnames to tenants** in middleware, and only serve tenant content once the domain is `active`. See [Resolve the tenant from the hostname](nextjs-cloudflare-workers.md#5-resolve-the-tenant-from-the-hostname-in-your-app).
- **Long requests.** The first `setupCustomDomain` call makes several provider calls. Keep `verification.waitForReady` off in request handlers, and check that your host's function timeout is generous enough.
- **Authorization is yours.** Domainwright keeps tenants apart through ownership markers, but your API must still check that the signed-in user may manage `tenantId`.
