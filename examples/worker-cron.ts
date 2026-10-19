/**
 * A Cloudflare Worker that re-checks pending domains from a Cron Trigger and records the
 * result in KV. Add to wrangler config:
 *
 *   triggers = { crons = ["*\/10 * * * *"] }
 *   kv_namespaces = [{ binding = "TENANT_DOMAINS", id = "..." }]
 *
 * and store CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and DOMAINPILOT_OWNERSHIP_SECRET as secrets.
 */
import { DomainPilot, type DomainLifecycleState, type SetupWorkflowState } from '../src/index.js';

/** Minimal KV surface used here; use `KVNamespace` from @cloudflare/workers-types in a real Worker. */
interface KvLike {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  list(options: { prefix: string; limit?: number }): Promise<{ keys: { name: string }[] }>;
}

interface Env {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  DOMAINPILOT_OWNERSHIP_SECRET: string;
  TENANT_DOMAINS: KvLike;
}

interface TenantDomain {
  tenantId: string;
  domain: string;
  lifecycle: DomainLifecycleState;
  state?: SetupWorkflowState;
}

const PENDING: DomainLifecycleState[] = ['pending', 'registering', 'configuring', 'verifying'];
/** Keep each run well inside the Workers subrequest limit. */
const BATCH_SIZE = 5;

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const client = new DomainPilot({
      cloudflare: { apiToken: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID },
      ownership: { secret: env.DOMAINPILOT_OWNERSHIP_SECRET },
    });

    const { keys } = await env.TENANT_DOMAINS.list({ prefix: 'domain:' });
    let processed = 0;
    for (const { name } of keys) {
      if (processed >= BATCH_SIZE) break;
      const row = (await env.TENANT_DOMAINS.get(name, 'json')) as TenantDomain | null;
      if (!row || !PENDING.includes(row.lifecycle)) continue;
      processed += 1;

      const result = await client.workflows.setupCustomDomain({
        domain: row.domain,
        tenantId: row.tenantId,
        worker: { name: 'property-source', environment: 'production' },
        dns: { root: true, www: true },
        resumeFrom: row.state,
      });
      const updated: TenantDomain = { ...row, lifecycle: result.lifecycle, state: result.state };
      await env.TENANT_DOMAINS.put(name, JSON.stringify(updated));
    }
  },
};
