/**
 * Domain readiness verification. Every check is reported individually; a successful
 * provider API call is never taken as proof of propagation, issuance or connectivity.
 */

import type { CloudflareClient } from '../cloudflare/client.js';
import { certificateReadiness } from '../cloudflare/certificates.js';
import { routeMatchesHostname } from '../cloudflare/workers.js';
import type { Zone } from '../cloudflare/zones.js';
import { nameserverInstructions } from '../cloudflare/zones.js';
import { isDomainPilotError, serializeError } from '../core/errors.js';
import type { FetchLike } from '../core/http.js';
import type { CheckId, CheckResult, CheckStatus, OutstandingAction } from '../core/types.js';
import { resolveWorkerService } from '../core/types.js';
import type { OwnershipModule } from '../ownership/ownership.js';
import type { RegistrarAdapter } from '../registrars/types.js';
import { poll } from '../utils/polling.js';
import { normalizeHostname, sameNameservers, unique } from '../utils/validation.js';
import { probeHttps } from './reachability.js';
import type { DnsResolver } from './resolver.js';
import type { CheckError, VerificationReport, VerifyDomainInput } from './types.js';

export interface VerifierDeps {
  cloudflare: CloudflareClient;
  resolver: DnsResolver;
  fetch: FetchLike;
  registrar?: RegistrarAdapter | undefined;
  ownership?: OwnershipModule | undefined;
}

const PROXIABLE = new Set(['A', 'AAAA', 'CNAME']);
const SAAS_FAILED = new Set(['moved', 'deleted', 'pending_deletion', 'blocked', 'test_blocked', 'test_failed']);

export class DomainVerifier {
  constructor(private readonly deps: VerifierDeps) {}

  async verify(input: VerifyDomainInput): Promise<VerificationReport> {
    if (!input.waitForReady) return this.runOnce(input, 1, false);
    let last: VerificationReport | undefined;
    const result = await poll(
      async (attempt) => {
        last = await this.runOnce(input, attempt, false);
        return { done: last.verified || last.summary === 'failed', value: last };
      },
      {
        timeoutMs: input.timeoutMs ?? 300_000,
        intervalMs: input.intervalMs ?? 15_000,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    return { ...result.value, attempts: result.attempts, timedOut: result.timedOut };
  }

  private async runOnce(input: VerifyDomainInput, attempts: number, timedOut: boolean): Promise<VerificationReport> {
    const domain = normalizeHostname(input.domain);
    const hostnames = unique((input.hostnames ?? [domain]).map((h) => normalizeHostname(h, { field: 'hostnames' })));
    const strategy = input.routing?.strategy ?? 'auto';
    const run = new CheckRun(input.checks);
    const signal = input.signal ? { signal: input.signal } : {};
    const service = input.worker ? resolveWorkerService(input.worker) : undefined;

    // Registration (informational unless the domain is in the registrar account).
    const registrableDomain = input.zone ? normalizeHostname(input.zone) : domain;
    await run.check('registration', undefined, async () => {
      const registrar = this.deps.registrar;
      if (!registrar?.getDomain || !registrar.capabilities.getDomain) {
        return { status: 'skipped', required: false, message: 'No registrar adapter with domain lookup is configured' };
      }
      const registered = await registrar.getDomain(registrableDomain, signal);
      if (!registered) {
        return {
          status: 'skipped',
          required: false,
          message: `${registrableDomain} is not in the ${registrar.displayName} account (registered elsewhere)`,
        };
      }
      const expired = registered.expiresAt !== null && Date.parse(registered.expiresAt) < Date.now();
      return {
        status: expired ? 'failed' : 'passed',
        required: true,
        message: expired
          ? `Registration expired on ${registered.expiresAt}`
          : `Registered with ${registrar.displayName}`,
        details: {
          expiresAt: registered.expiresAt,
          autoRenew: registered.autoRenew,
          nameservers: registered.nameservers,
        },
      };
    });
    const registrarNameservers = run.get('registration')?.details?.nameservers as string[] | undefined;

    if (input.routing?.strategy === 'saas-custom-hostname') {
      await this.saasChecks(input, input.routing, hostnames, run, service);
    } else {
      await this.zoneChecks(input, domain, hostnames, run, service, registrarNameservers, strategy);
    }

    return run.report(domain, hostnames, strategy, attempts, timedOut);
  }

  private async zoneChecks(
    input: VerifyDomainInput,
    domain: string,
    hostnames: string[],
    run: CheckRun,
    service: string | undefined,
    registrarNameservers: string[] | undefined,
    strategy: VerificationReport['strategy'],
  ): Promise<void> {
    const { cloudflare, resolver } = this.deps;
    const signal = input.signal ? { signal: input.signal } : {};
    const zoneName = input.zone ? normalizeHostname(input.zone) : domain;
    let zone: Zone | null = null;

    await run.check('zone', undefined, async () => {
      zone = await cloudflare.zones.find(zoneName, signal);
      if (!zone)
        return { status: 'failed', required: true, message: `No Cloudflare zone for ${zoneName} in the account` };
      return {
        status: 'passed',
        required: true,
        message: `Zone ${zone.name} exists (${zone.status})`,
        details: { zoneId: zone.id, status: zone.status },
      };
    });
    const z = zone as Zone | null;

    await run.check('nameservers', undefined, async () => {
      if (!z) return { status: 'blocked', required: true, message: 'Requires the Cloudflare zone' };
      if (z.status === 'active')
        return { status: 'passed', required: true, message: 'Nameservers are delegated to Cloudflare' };
      const action = {
        type: 'update-nameservers' as const,
        domain: z.name,
        nameservers: z.nameservers,
        ...(registrarNameservers ? { currentNameservers: registrarNameservers } : {}),
        automatable: Boolean(this.deps.registrar?.capabilities.setNameservers && registrarNameservers),
        instructions: nameserverInstructions(z).instructions,
      };
      if (registrarNameservers && !sameNameservers(registrarNameservers, z.nameservers)) {
        return {
          status: 'pending',
          required: true,
          message: 'The registrar still lists other nameservers',
          action,
          details: { registrarNameservers },
        };
      }
      const answer = await resolver.resolve(z.name, 'NS', signal);
      if (answer.status === 'error')
        return { status: 'error', required: true, message: `NS lookup failed: ${answer.error ?? 'unknown'}` };
      if (answer.status === 'ok' && sameNameservers(answer.values, z.nameservers)) {
        return {
          status: 'pending',
          required: true,
          message: 'Delegation is visible in public DNS; waiting for Cloudflare to activate the zone',
          details: { observed: answer.values },
        };
      }
      return {
        status: 'pending',
        required: true,
        message: 'Public DNS does not yet show the Cloudflare nameservers',
        action,
        details: { observed: answer.values },
      };
    });

    await run.check('zone-activation', undefined, async () => {
      if (!z) return { status: 'blocked', required: true, message: 'Requires the Cloudflare zone' };
      if (z.status === 'active')
        return { status: 'passed', required: true, message: `Zone active since ${z.activatedOn ?? 'unknown'}` };
      if (z.status === 'moved')
        return {
          status: 'failed',
          required: true,
          message: 'Zone status is "moved": the domain no longer uses Cloudflare nameservers',
        };
      return {
        status: 'pending',
        required: true,
        message: `Zone status is "${z.status}"`,
        action: { type: 'wait', reason: 'Cloudflare activates the zone after detecting the nameserver change' },
      };
    });
    const zoneActive = run.get('zone-activation')?.status === 'passed';

    await run.check('ownership', undefined, async () => {
      if (!input.tenantId) return { status: 'skipped', required: false, message: 'No tenantId supplied' };
      if (!this.deps.ownership)
        return {
          status: 'error',
          required: true,
          message: 'tenantId requires ownership configuration (ownership.secret)',
        };
      if (!zoneActive)
        return {
          status: 'blocked',
          required: true,
          message: 'The ownership record is only visible in public DNS once the zone is active',
        };
      const result = await this.deps.ownership.verifyChallenge({
        hostname: domain,
        tenantId: input.tenantId,
        ...signal,
      });
      const messages = {
        verified: 'Ownership record for this tenant is published',
        missing: 'Ownership record not found in public DNS yet',
        'other-tenant': 'Only an ownership record for a different tenant is published',
        'lookup-failed': 'Ownership TXT lookup failed',
      };
      return {
        status: result.status,
        required: true,
        message: messages[result.reason],
        details: { record: result.record.name },
      };
    });

    // DNS records in the zone.
    for (const hostname of hostnames) {
      await run.check('dns-records', hostname, async () => {
        if (!z) return { status: 'blocked', required: true, message: 'Requires the Cloudflare zone' };
        if (strategy === 'custom-domain')
          return { status: 'skipped', required: false, message: 'Workers Custom Domains manage their own DNS record' };
        if (strategy === 'auto')
          return { status: 'skipped', required: false, message: 'Routing strategy not specified' };
        const records = await cloudflare.dns.list({ zoneId: z.id, name: hostname, ...signal });
        const proxied = records.find((r) => PROXIABLE.has(r.type) && r.proxied);
        if (proxied)
          return {
            status: 'passed',
            required: true,
            message: `Proxied ${proxied.type} record present`,
            details: { recordId: proxied.id },
          };
        return {
          status: 'failed',
          required: true,
          message: 'Workers Routes require a proxied A, AAAA or CNAME record for the hostname',
          action: {
            type: 'add-dns-record',
            owner: 'platform',
            record: { type: 'AAAA', name: hostname, content: '100::' },
            instructions: `Create a proxied AAAA record ${hostname} -> 100:: (originless) so the route can run.`,
          },
        };
      });
    }

    // Routing to the Worker.
    for (const hostname of hostnames) {
      await run.check('routing', hostname, async () => {
        if (!z) return { status: 'blocked', required: true, message: 'Requires the Cloudflare zone' };
        const wantCustomDomain = strategy === 'custom-domain' || strategy === 'auto';
        const wantRoute = strategy === 'route' || strategy === 'auto';
        if (wantCustomDomain) {
          const attached = await cloudflare.workers.customDomains.findByHostname(hostname, signal);
          if (attached) {
            if (service && attached.service !== service) {
              return {
                status: 'failed',
                required: true,
                message: `Attached to Worker "${attached.service}", expected "${service}"`,
                details: { service: attached.service },
              };
            }
            return {
              status: 'passed',
              required: true,
              message: `Workers Custom Domain attached to "${attached.service}"`,
              details: { strategy: 'custom-domain', service: attached.service, customDomainId: attached.id },
            };
          }
        }
        if (wantRoute) {
          const routes = (await cloudflare.workers.routes.list(z.id, signal)).filter((r) =>
            routeMatchesHostname(r.pattern, hostname),
          );
          const match = routes.find((r) => r.script && (!service || r.script === service));
          if (match)
            return {
              status: 'passed',
              required: true,
              message: `Route ${match.pattern} runs "${match.script ?? ''}"`,
              details: { strategy: 'route', service: match.script, routeId: match.id },
            };
          if (routes.length) {
            return {
              status: 'failed',
              required: true,
              message: `Routes match ${hostname} but none runs the expected Worker`,
              details: { routes: routes.map((r) => ({ pattern: r.pattern, script: r.script })) },
            };
          }
        }
        return { status: 'failed', required: true, message: `No Worker routing is configured for ${hostname}` };
      });
    }

    // Certificates.
    for (const hostname of hostnames) {
      await run.check('certificate', hostname, async () => {
        if (!z) return { status: 'blocked', required: true, message: 'Requires the Cloudflare zone' };
        if (!zoneActive)
          return { status: 'blocked', required: true, message: 'Certificates are issued after the zone is active' };
        const cert = await cloudflare.certificates.statusFor(z.id, hostname, signal);
        const details = { packId: cert.packId, status: cert.status, validationErrors: cert.validationErrors };
        if (cert.readiness === 'active')
          return { status: 'passed', required: true, message: 'Edge certificate is active', details };
        if (cert.readiness === 'failed')
          return { status: 'failed', required: true, message: `Certificate status "${cert.status ?? ''}"`, details };
        return {
          status: 'pending',
          required: true,
          message:
            cert.readiness === 'missing'
              ? 'No certificate covers this hostname yet'
              : `Certificate status "${cert.status ?? ''}"`,
          details,
        };
      });
    }

    await this.publicChecks(input, hostnames, run, () => zoneActive);
  }

  private async saasChecks(
    input: VerifyDomainInput,
    routing: Extract<NonNullable<VerifyDomainInput['routing']>, { strategy: 'saas-custom-hostname' }>,
    hostnames: string[],
    run: CheckRun,
    service: string | undefined,
  ): Promise<void> {
    const { cloudflare, resolver } = this.deps;
    const signal = input.signal ? { signal: input.signal } : {};
    const target = normalizeHostname(routing.cnameTarget, { field: 'cnameTarget' });
    let saasZone: Zone | null = null;

    await run.check('zone', undefined, async () => {
      saasZone = await cloudflare.zones.get(routing.saasZoneId, signal);
      if (saasZone.status !== 'active')
        return { status: 'failed', required: true, message: `SaaS zone ${saasZone.name} is not active` };
      return {
        status: 'passed',
        required: true,
        message: `SaaS zone ${saasZone.name} is active`,
        details: { zoneId: saasZone.id },
      };
    });
    run.add({ id: 'nameservers', status: 'skipped', required: false, message: 'Tenant keeps DNS at their provider' });
    run.add({
      id: 'zone-activation',
      status: 'skipped',
      required: false,
      message: 'Tenant keeps DNS at their provider',
    });

    for (const hostname of hostnames) {
      await run.check('ownership', hostname, async () => {
        if (!input.tenantId) return { status: 'skipped', required: false, message: 'No tenantId supplied' };
        if (!this.deps.ownership)
          return {
            status: 'error',
            required: true,
            message: 'tenantId requires ownership configuration (ownership.secret)',
          };
        const result = await this.deps.ownership.verifyChallenge({ hostname, tenantId: input.tenantId, ...signal });
        const action: OutstandingAction | undefined =
          result.status === 'passed'
            ? undefined
            : {
                type: 'add-dns-record',
                owner: 'tenant',
                record: { type: 'TXT', name: result.record.name, content: result.record.content },
                instructions: `Ask the tenant to add TXT ${result.record.name} = ${result.record.content} at their DNS provider.`,
              };
        return {
          status: result.status,
          required: true,
          message: `Tenant ownership record: ${result.reason}`,
          ...(action ? { action } : {}),
        };
      });

      await run.check('dns-records', hostname, async () => {
        const answer = await resolver.resolve(hostname, 'CNAME', signal);
        if (answer.status === 'error')
          return { status: 'error', required: true, message: `CNAME lookup failed: ${answer.error ?? ''}` };
        const action: OutstandingAction = {
          type: 'add-dns-record',
          owner: 'tenant',
          record: { type: 'CNAME', name: hostname, content: target },
          instructions: `Ask the tenant to create CNAME ${hostname} -> ${target}. Apex domains need CNAME flattening (or an ALIAS/ANAME record) at their DNS provider.`,
        };
        if (answer.values.includes(target))
          return { status: 'passed', required: true, message: `CNAME points to ${target}` };
        if (answer.values.length)
          return {
            status: 'failed',
            required: true,
            message: `CNAME points to ${answer.values.join(', ')}, expected ${target}`,
            action,
          };
        // Flattened apex records cannot be checked by name; rely on Cloudflare's hostname status.
        return { status: 'pending', required: true, message: `No CNAME to ${target} observed`, action };
      });

      await run.check('routing', hostname, async () => {
        const custom = await cloudflare.customHostnames.find(routing.saasZoneId, hostname, signal);
        if (!custom) return { status: 'failed', required: true, message: 'No custom hostname exists in the SaaS zone' };
        const routes = await cloudflare.workers.routes.list(routing.saasZoneId, signal);
        const route = routes.find(
          (r) => routeMatchesHostname(r.pattern, hostname) && r.script && (!service || r.script === service),
        );
        const details = {
          customHostnameId: custom.id,
          status: custom.status,
          verificationErrors: custom.verificationErrors,
        };
        if (SAAS_FAILED.has(custom.status))
          return { status: 'failed', required: true, message: `Custom hostname status "${custom.status}"`, details };
        if (!route) {
          return {
            status: 'failed',
            required: true,
            message: `No Worker route on the SaaS zone serves ${hostname}${service ? ` with "${service}"` : ''}`,
            details,
            action: {
              type: 'configure-worker-route',
              zone: saasZone ? saasZone.name : routing.saasZoneId,
              pattern: '*/*',
              service: service ?? '<worker>',
              instructions: 'Add a Worker route such as */* on the SaaS zone so custom hostnames reach the Worker.',
            },
          };
        }
        if (custom.status !== 'active') {
          const ov = custom.ownershipVerification;
          return {
            status: 'pending',
            required: true,
            message: `Custom hostname status "${custom.status}"`,
            details,
            ...(ov
              ? {
                  action: {
                    type: 'add-dns-record' as const,
                    owner: 'tenant' as const,
                    record: { type: 'TXT', name: ov.name, content: ov.value },
                    instructions: `Optional pre-validation: the tenant can add TXT ${ov.name} = ${ov.value} to activate before switching traffic.`,
                  },
                }
              : {}),
          };
        }
        return {
          status: 'passed',
          required: true,
          message: `Custom hostname active; route ${route.pattern} runs "${route.script ?? ''}"`,
          details,
        };
      });

      await run.check('certificate', hostname, async () => {
        const custom = await cloudflare.customHostnames.find(routing.saasZoneId, hostname, signal);
        if (!custom) return { status: 'blocked', required: true, message: 'Requires the custom hostname' };
        const readiness = certificateReadiness(custom.ssl.status);
        const details = {
          status: custom.ssl.status,
          method: custom.ssl.method,
          validationErrors: custom.ssl.validationErrors,
        };
        if (readiness === 'active')
          return { status: 'passed', required: true, message: 'Certificate is active', details };
        if (readiness === 'failed')
          return {
            status: 'failed',
            required: true,
            message: `Certificate status "${custom.ssl.status ?? ''}"`,
            details,
          };
        return {
          status: 'pending',
          required: true,
          message: `Certificate status "${custom.ssl.status ?? 'pending'}"`,
          details,
        };
      });
    }

    await this.publicChecks(input, hostnames, run, () => true);
  }

  /** Public DNS resolution and HTTPS reachability. */
  private async publicChecks(
    input: VerifyDomainInput,
    hostnames: string[],
    run: CheckRun,
    prerequisite: () => boolean,
  ): Promise<void> {
    const signal = input.signal ? { signal: input.signal } : {};
    for (const hostname of hostnames) {
      await run.check('dns-resolution', hostname, async () => {
        if (!prerequisite()) return { status: 'blocked', required: true, message: 'Waiting for zone activation' };
        const [a, aaaa] = await Promise.all([
          this.deps.resolver.resolve(hostname, 'A', signal),
          this.deps.resolver.resolve(hostname, 'AAAA', signal),
        ]);
        const values = [...a.values, ...aaaa.values];
        if (values.length)
          return {
            status: 'passed',
            required: true,
            message: `Resolves to ${values.slice(0, 4).join(', ')}`,
            details: { addresses: values },
          };
        if (a.status === 'error' && aaaa.status === 'error')
          return { status: 'error', required: true, message: 'DNS lookups failed' };
        return {
          status: 'pending',
          required: true,
          message: a.status === 'nxdomain' ? 'Name does not resolve yet (NXDOMAIN)' : 'No address records yet',
        };
      });
      await run.check('https', hostname, async () => {
        if (input.https === false)
          return { status: 'skipped', required: false, message: 'Reachability check disabled' };
        if (
          run.get('certificate', hostname)?.status !== 'passed' ||
          run.get('dns-resolution', hostname)?.status !== 'passed'
        ) {
          return {
            status: 'blocked',
            required: true,
            message: 'Requires an active certificate and public DNS resolution',
          };
        }
        const result = await probeHttps(this.deps.fetch, hostname, input.https ?? {}, signal);
        const details = { url: result.url, httpStatus: result.status, outcome: result.outcome };
        if (result.outcome === 'ok') return { status: 'passed', required: true, message: result.message, details };
        if (result.outcome === 'unexpected-response')
          return { status: 'failed', required: true, message: result.message, details };
        return { status: 'pending', required: true, message: result.message, details };
      });
    }
  }
}

type CheckOutcome = Omit<CheckResult, 'id' | 'hostname'>;

/** Collects check results and converts thrown provider errors into `error` results. */
class CheckRun {
  private readonly results: CheckResult[] = [];
  private readonly errors: CheckError[] = [];

  constructor(private readonly only?: CheckId[]) {}

  get(id: CheckId, hostname?: string): CheckResult | undefined {
    return this.results.find((r) => r.id === id && r.hostname === hostname);
  }

  add(result: CheckResult): void {
    if (this.only && !this.only.includes(result.id)) return;
    this.results.push(result);
  }

  async check(id: CheckId, hostname: string | undefined, fn: () => Promise<CheckOutcome>): Promise<void> {
    if (this.only && !this.only.includes(id)) return;
    let outcome: CheckOutcome;
    try {
      outcome = await fn();
    } catch (error) {
      if (isDomainPilotError(error, 'ABORTED')) throw error;
      const serialized = serializeError(error);
      outcome = { status: 'error', required: true, message: serialized.message };
      this.errors.push({
        check: id,
        ...(hostname ? { hostname } : {}),
        status: 'error',
        message: serialized.message,
        error: serialized,
      });
    }
    const result: CheckResult = { id, ...(hostname ? { hostname } : {}), ...outcome };
    if (outcome.status === 'failed') {
      this.errors.push({ check: id, ...(hostname ? { hostname } : {}), status: 'failed', message: outcome.message });
    }
    this.results.push(result);
  }

  report(
    domain: string,
    hostnames: string[],
    strategy: VerificationReport['strategy'],
    attempts: number,
    timedOut: boolean,
  ): VerificationReport {
    const required = this.results.filter((r) => r.required);
    const has = (status: CheckStatus): boolean => required.some((r) => r.status === status);
    const verified = required.length > 0 && required.every((r) => r.status === 'passed');
    const summary: VerificationReport['summary'] = verified
      ? 'verified'
      : has('failed')
        ? 'failed'
        : has('error')
          ? 'error'
          : 'pending';
    const outstandingActions = dedupeActions(
      this.results.flatMap((r) => (r.action && r.status !== 'passed' ? [r.action] : [])),
    );
    return {
      domain,
      hostnames,
      strategy,
      verified,
      summary,
      checks: this.results,
      errors: this.errors,
      outstandingActions,
      checkedAt: new Date().toISOString(),
      attempts,
      timedOut,
    };
  }
}

function dedupeActions(actions: OutstandingAction[]): OutstandingAction[] {
  const seen = new Set<string>();
  return actions.filter((a) => {
    const key = JSON.stringify(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
