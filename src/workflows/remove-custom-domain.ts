/**
 * Safe removal. Only resources DomainPilot can attribute to this domain, Worker and tenant
 * are removed; everything else is reported in `retained`. The zone is deleted only on
 * explicit request and only when it contains nothing but DomainPilot-managed records.
 */

import type { DnsRecord } from '../cloudflare/dns.js';
import { routeMatchesHostname } from '../cloudflare/workers.js';
import type { Zone } from '../cloudflare/zones.js';
import { ConfirmationRequiredError, TenantConflictError, ValidationError, serializeError } from '../core/errors.js';
import { resolveWorkerService } from '../core/types.js';
import { normalizeHostname } from '../utils/validation.js';
import type { RoutingSpec } from '../verification/types.js';
import { type WorkflowDeps, now, selectHostnames } from './context.js';
import type {
  PlannedChange,
  RemovalStepId,
  RemoveCustomDomainInput,
  RemoveCustomDomainResult,
  StepRecord,
} from './types.js';

const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME']);

export async function removeCustomDomain(
  deps: WorkflowDeps,
  input: RemoveCustomDomainInput,
): Promise<RemoveCustomDomainResult> {
  const domain = normalizeHostname(input.domain);
  const dryRun = input.dryRun ?? false;
  if (!dryRun && input.confirm !== true) {
    throw new ConfirmationRequiredError(
      'Removing a custom domain is destructive; pass confirm: true (or dryRun: true to preview)',
      { domain },
    );
  }
  if (input.tenantId !== undefined && !deps.ownership) {
    throw new ValidationError('tenantId requires ownership.secret in the client configuration', { field: 'tenantId' });
  }
  const hostnames = selectHostnames(domain, input.dns);
  const routing: RoutingSpec = input.routing ?? { strategy: 'custom-domain' };
  const service = input.worker ? resolveWorkerService(input.worker) : undefined;
  const zoneName = input.zone?.name ? normalizeHostname(input.zone.name) : domain;
  const isOwnZone = zoneName === domain;
  const signal = input.signal ? { signal: input.signal } : {};
  const { cloudflare, ownership } = deps;
  const tenantTag = input.tenantId !== undefined ? await ownership!.tenantTag(input.tenantId) : undefined;

  const steps: StepRecord<RemovalStepId>[] = (['validate', 'tenant', 'routing', 'dns', 'zone'] as const).map((id) => ({
    id,
    status: 'pending',
  }));
  const result: RemoveCustomDomainResult = {
    domain,
    hostnames,
    lifecycle: 'disabled',
    dryRun,
    steps,
    removed: { customDomains: [], routes: [], customHostnames: [], dnsRecords: [], zone: null },
    retained: [],
    errors: [],
  };
  const planned = new Map<RemovalStepId, PlannedChange[]>();
  const plan = (step: RemovalStepId, change: PlannedChange): void => {
    planned.set(step, [...(planned.get(step) ?? []), change]);
  };
  let zone: Zone | null = null;

  const run = async (id: RemovalStepId, fn: () => Promise<string>): Promise<boolean> => {
    const record = steps.find((s) => s.id === id)!;
    record.startedAt = now();
    try {
      record.message = await fn();
      const changes = planned.get(id);
      record.status = dryRun && changes?.length ? 'planned' : 'succeeded';
      if (changes?.length) record.planned = changes;
      return true;
    } catch (error) {
      record.status = 'failed';
      record.error = serializeError(error);
      record.message = record.error.message;
      result.errors.push({ ...record.error, step: id });
      return false;
    } finally {
      record.finishedAt = now();
    }
  };

  const finish = (): RemoveCustomDomainResult => {
    const failed = steps.some((s) => s.status === 'failed');
    result.lifecycle = dryRun ? 'unchanged' : failed ? 'failed' : 'disabled';
    for (const s of steps) if (s.status === 'pending') s.status = 'skipped';
    return result;
  };

  await run('validate', async () => `Removing ${hostnames.join(', ')} (${routing.strategy})`);

  const tenantOk = await run('tenant', async () => {
    if (routing.strategy === 'saas-custom-hostname') {
      return 'Tenant check relies on the custom hostname belonging to the SaaS zone';
    }
    zone = await cloudflare.zones.find(zoneName, signal);
    if (!zone) return `Zone ${zoneName} not found; nothing to check`;
    if (!ownership) return 'Ownership not configured; skipping marker check';
    const markerName = `${ownership.recordPrefix}.${domain}`;
    const markers = (await cloudflare.dns.list({ zoneId: zone.id, name: markerName, type: 'TXT', ...signal })).filter(
      (r) => ownership.isChallengeValue(r.content),
    );
    if (!markers.length) return 'No ownership marker present';
    if (input.tenantId === undefined) {
      throw new TenantConflictError(`${domain} has a tenant ownership marker; pass the owning tenantId to remove it`, {
        domain,
      });
    }
    for (const marker of markers) {
      if (!(await ownership.matches(marker.content, domain, input.tenantId))) {
        throw new TenantConflictError(`${domain} belongs to a different tenant`, { domain });
      }
    }
    return 'Ownership marker matches this tenant';
  });
  if (!tenantOk) return finish();

  await run('routing', async () => {
    if (routing.strategy === 'saas-custom-hostname') {
      for (const hostname of hostnames) {
        const custom = await cloudflare.customHostnames.find(routing.saasZoneId, hostname, signal);
        if (!custom) continue;
        if (dryRun) plan('routing', { operation: 'cloudflare.customHostnames.delete', target: hostname });
        else
          await cloudflare.customHostnames.delete({
            zoneId: routing.saasZoneId,
            customHostnameId: custom.id,
            confirm: true,
            ...signal,
          });
        result.removed.customHostnames.push(hostname);
      }
      return 'Custom hostnames removed';
    }
    const z = zone;
    if (!z) return 'No zone; no routing to remove';
    for (const hostname of hostnames) {
      const attached = await cloudflare.workers.customDomains.findByHostname(hostname, signal);
      if (attached) {
        if (service && attached.service !== service) {
          result.retained.push({
            resource: `custom-domain:${hostname}`,
            reason: `attached to a different Worker (${attached.service})`,
          });
        } else {
          if (dryRun) plan('routing', { operation: 'cloudflare.workers.customDomains.detach', target: hostname });
          else await cloudflare.workers.customDomains.detach({ domainId: attached.id, confirm: true, ...signal });
          result.removed.customDomains.push(hostname);
        }
      }
    }
    const routes = await cloudflare.workers.routes.list(z.id, signal);
    for (const route of routes) {
      // Only the exact per-hostname patterns the onboarding workflow creates are removed;
      // wildcard routes may serve other tenants.
      if (!hostnames.some((h) => route.pattern === `${h}/*`)) {
        if (hostnames.some((h) => routeMatchesHostname(route.pattern, h))) {
          result.retained.push({ resource: `route:${route.pattern}`, reason: 'pattern also matches other hostnames' });
        }
        continue;
      }
      if (service && route.script !== service) {
        result.retained.push({
          resource: `route:${route.pattern}`,
          reason: `runs a different Worker (${route.script ?? 'none'})`,
        });
        continue;
      }
      if (dryRun) plan('routing', { operation: 'cloudflare.workers.routes.delete', target: route.pattern });
      else await cloudflare.workers.routes.delete({ zoneId: z.id, routeId: route.id, confirm: true, ...signal });
      result.removed.routes.push(route.pattern);
    }
    return 'Worker routing removed';
  });

  await run('dns', async () => {
    const z = zone;
    if (routing.strategy === 'saas-custom-hostname' || !z) return 'No zone records to remove';
    const names = [...hostnames, ...(ownership ? [`${ownership.recordPrefix}.${domain}`] : [])];
    for (const name of names) {
      const records = await cloudflare.dns.list({ zoneId: z.id, name, ...signal });
      for (const record of records) {
        if (!isRemovable(record, tenantTag)) {
          result.retained.push({
            resource: `dns:${record.type} ${record.name}`,
            reason: record.managed ? 'managed for a different tenant' : 'not created by DomainPilot',
          });
          continue;
        }
        if (!ADDRESS_TYPES.has(record.type) && record.type !== 'TXT') {
          result.retained.push({
            resource: `dns:${record.type} ${record.name}`,
            reason: 'record type is not removed automatically',
          });
          continue;
        }
        if (dryRun)
          plan('dns', { operation: 'cloudflare.dns.delete', target: record.name, details: { type: record.type } });
        else await cloudflare.dns.delete({ zoneId: z.id, recordId: record.id, confirm: true, ...signal });
        result.removed.dnsRecords.push(`${record.type} ${record.name}`);
      }
    }
    return 'Managed DNS records removed';
  });

  await run('zone', async () => {
    const z = zone;
    if (!input.deleteZone) return 'Zone kept (deleteZone not requested)';
    if (!z || !isOwnZone) {
      result.retained.push({
        resource: `zone:${zoneName}`,
        reason: isOwnZone ? 'not found' : 'shared parent zone is never deleted',
      });
      return 'Zone not deleted';
    }
    const remaining = (await cloudflare.dns.list({ zoneId: z.id, ...signal })).filter(
      (r) => !(dryRun && result.removed.dnsRecords.includes(`${r.type} ${r.name}`)),
    );
    const foreign = remaining.filter((r) => !isRemovable(r, tenantTag) && r.type !== 'NS');
    if (foreign.length) {
      result.retained.push({
        resource: `zone:${z.name}`,
        reason: `${foreign.length} record(s) not managed by DomainPilot remain`,
      });
      return 'Zone not deleted: it contains unmanaged records';
    }
    if (dryRun) plan('zone', { operation: 'cloudflare.zones.delete', target: z.name });
    else await cloudflare.zones.delete({ zoneId: z.id, confirm: true, ...signal });
    result.removed.zone = z.name;
    return 'Zone deleted';
  });

  return finish();
}

function isRemovable(record: DnsRecord, tenantTag: string | undefined): boolean {
  return record.managed && record.tenantTag === (tenantTag ?? null);
}
