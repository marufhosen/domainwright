/**
 * Onboard a tenant domain that the tenant already owns: preview, then apply, then persist the
 * state so a later run can resume. No domain is purchased (no `registration` block).
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... DOMAINWRIGHT_OWNERSHIP_SECRET=... \
 *   npx tsx examples/onboarding.ts marketplace-a.com tenant_123
 */
import { readFile, writeFile } from 'node:fs/promises';
import { Domainwright, type SetupCustomDomainInput, type SetupWorkflowState } from '../src/index.js';

const [domain = 'marketplace-a.com', tenantId = 'tenant_123'] = process.argv.slice(2);
const stateFile = `.domainwright-${domain}.json`;

const client = new Domainwright({
  cloudflare: { apiToken: process.env.CLOUDFLARE_API_TOKEN ?? '', accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '' },
  ownership: { secret: process.env.DOMAINWRIGHT_OWNERSHIP_SECRET ?? '' },
});

async function loadState(): Promise<SetupWorkflowState | undefined> {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8')) as SetupWorkflowState;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const input: SetupCustomDomainInput = {
    domain,
    tenantId,
    worker: { name: 'property-source', environment: 'production' },
    dns: { root: true, www: true },
    verification: { https: { path: '/.well-known/domainwright-health', status: [200] } },
    resumeFrom: await loadState(),
    onCheckpoint: (state) => writeFile(stateFile, JSON.stringify(state, null, 2)),
  };

  const preview = await client.workflows.setupCustomDomain({ ...input, dryRun: true });
  for (const step of preview.steps) {
    for (const change of step.planned ?? []) console.log(`[plan] ${step.id}: ${change.operation} ${change.target}`);
  }

  const result = await client.workflows.setupCustomDomain(input);
  console.log(`lifecycle: ${result.lifecycle}, ready: ${String(result.ready)}`);
  for (const action of result.outstandingActions) {
    if (action.type === 'update-nameservers')
      console.log(`Ask the tenant to set nameservers: ${action.nameservers.join(', ')}`);
    else if (action.type === 'add-dns-record')
      console.log(`${action.owner} must add ${action.record.type} ${action.record.name} ${action.record.content}`);
    else if (action.type === 'wait') console.log(`Waiting: ${action.reason}`);
    else console.log(action.instructions);
  }
  for (const error of result.errors) console.error(`${error.step}: ${error.code} ${error.message}`);
}

void main();
