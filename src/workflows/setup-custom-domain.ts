/**
 * End-to-end, resumable custom-domain onboarding. Composes the independent modules; it
 * contains orchestration and safety policy only, no provider calls of its own.
 *
 * Order: validate -> registration -> zone -> ownership -> nameservers -> dns -> routing -> verification.
 * Ownership runs before anything that changes registrar or routing state, so a zone or
 * hostname claimed by another tenant stops the workflow before any change is made.
 */

import type { DnsRecord } from '../cloudflare/dns.js';
import type { Zone } from '../cloudflare/zones.js';
import {
  ConfigurationError,
  DomainPilotError,
  PurchaseError,
  TenantConflictError,
  ValidationError,
  isDomainPilotError,
  serializeError,
} from '../core/errors.js';
import type { OutstandingAction, RoutingStrategy } from '../core/types.js';
import { resolveWorkerService } from '../core/types.js';
import { supports } from '../domains/capabilities.js';
import { randomId } from '../utils/crypto.js';
import { normalizeHostname, sameNameservers } from '../utils/validation.js';
import type { RoutingSpec, VerificationReport } from '../verification/types.js';
import { type WorkflowDeps, deriveLifecycle, now, selectHostnames } from './context.js';
import type {
  PlannedChange,
  SetupCustomDomainInput,
  SetupCustomDomainResult,
  SetupStepId,
  SetupWorkflowState,
  StepRecord,
} from './types.js';

const STEP_IDS: SetupStepId[] = [
  'validate',
  'registration',
  'zone',
  'ownership',
  'nameservers',
  'dns',
  'routing',
  'verification',
];
/** name.com keeps idempotency results for one hour; stay safely inside that window. */
const IDEMPOTENCY_WINDOW_MS = 55 * 60 * 1000;
const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME']);

type StepOutcome = Pick<StepRecord, 'status' | 'message' | 'actions' | 'planned'>;

class StopWorkflow extends Error {}

function registrationAction(status: 'pending' | 'action-required'): OutstandingAction {
  return status === 'pending'
    ? { type: 'wait', reason: 'Registry completion' }
    : {
        type: 'manual',
        instructions:
          'The registrar needs an action before it completes the registration (for example contact verification or registry documents). Complete it in the registrar account, then resume.',
      };
}

export async function setupCustomDomain(
  deps: WorkflowDeps,
  input: SetupCustomDomainInput,
): Promise<SetupCustomDomainResult> {
  return new SetupRun(deps, input).run();
}

class SetupRun {
  private readonly domain: string;
  private readonly hostnames: string[];
  private readonly routing: RoutingSpec;
  private readonly strategy: RoutingStrategy;
  private readonly service: string;
  private readonly zoneName: string;
  private readonly isOwnZone: boolean;
  private readonly dryRun: boolean;
  private readonly state: SetupWorkflowState;
  private readonly signal: { signal?: AbortSignal };
  private zone: Zone | null = null;
  private tenantTag: string | undefined;
  private verification: VerificationReport | undefined;
  private checkpointError: DomainPilotError | undefined;

  constructor(
    private readonly deps: WorkflowDeps,
    private readonly input: SetupCustomDomainInput,
  ) {
    this.domain = normalizeHostname(input.domain);
    this.routing = input.routing ?? { strategy: 'custom-domain' };
    this.strategy = this.routing.strategy;
    if (!input.worker || (!input.worker.name && !input.worker.service)) {
      throw new ValidationError('worker.name (or worker.service) is required', { field: 'worker' });
    }
    this.service = resolveWorkerService(input.worker);
    this.hostnames = selectHostnames(this.domain, input.dns);
    this.zoneName = input.zone?.name ? normalizeHostname(input.zone.name, { field: 'zone.name' }) : this.domain;
    this.isOwnZone = this.zoneName === this.domain;
    this.dryRun = input.dryRun ?? false;
    this.signal = input.signal ? { signal: input.signal } : {};
    this.validateInput();
    this.state = this.initialState();
  }

  private validateInput(): void {
    const { input } = this;
    if (!this.isOwnZone && !this.domain.endsWith(`.${this.zoneName}`)) {
      throw new ValidationError(`${this.domain} is not inside zone ${this.zoneName}`, { field: 'zone.name' });
    }
    if (input.tenantId !== undefined && !this.deps.ownership) {
      throw new ConfigurationError('tenantId requires ownership.secret in the client configuration', {
        field: 'ownership',
      });
    }
    if (input.registration) {
      if (!input.registration.purchase)
        throw new ValidationError('registration.purchase must be true', { field: 'registration' });
      if (!this.deps.registration || !this.deps.registrar) {
        throw new ConfigurationError('registration requires a registrar in the client configuration', {
          field: 'registrar',
        });
      }
      if (!this.isOwnZone)
        throw new ValidationError('registration applies to apex domains only', { field: 'registration' });
    }
    if (this.strategy === 'saas-custom-hostname') {
      const r = this.routing as Extract<RoutingSpec, { strategy: 'saas-custom-hostname' }>;
      if (!r.saasZoneId || !r.cnameTarget) {
        throw new ValidationError('saas-custom-hostname routing requires saasZoneId and cnameTarget', {
          field: 'routing',
        });
      }
      if (input.dns?.records?.length) {
        throw new ValidationError('dns.records is not supported for SaaS custom hostnames: the tenant controls DNS', {
          field: 'dns.records',
        });
      }
      if (input.registration) {
        throw new ValidationError('registration is not supported with saas-custom-hostname routing', {
          field: 'registration',
        });
      }
    }
  }

  private initialState(): SetupWorkflowState {
    const previous = this.input.resumeFrom;
    const tenantId = this.input.tenantId ?? null;
    if (previous) {
      const mismatch =
        previous.workflow !== 'setup-custom-domain' ||
        previous.version !== 1 ||
        previous.domain !== this.domain ||
        previous.tenantId !== tenantId ||
        previous.strategy !== this.strategy ||
        previous.service !== this.service;
      if (mismatch) {
        throw new DomainPilotError(
          'WORKFLOW_STATE_MISMATCH',
          'resumeFrom belongs to a different domain, tenant, strategy or Worker',
          {
            details: { domain: previous.domain, strategy: previous.strategy },
          },
        );
      }
      const copy = JSON.parse(JSON.stringify(previous)) as SetupWorkflowState;
      copy.hostnames = this.hostnames;
      for (const step of copy.steps) {
        // Re-run everything except a completed registration.
        if (!(step.id === 'registration' && (step.status === 'succeeded' || step.status === 'skipped'))) {
          step.status = 'pending';
          delete step.error;
          delete step.actions;
          delete step.planned;
          delete step.message;
        }
      }
      return copy;
    }
    const createdAt = now();
    return {
      version: 1,
      workflow: 'setup-custom-domain',
      domain: this.domain,
      tenantId,
      hostnames: this.hostnames,
      strategy: this.strategy,
      service: this.service,
      lifecycle: 'pending',
      steps: STEP_IDS.map((id) => ({ id, status: 'pending' })),
      resources: { dnsRecords: [], customDomains: [], routes: [], customHostnames: [] },
      createdAt,
      updatedAt: createdAt,
    };
  }

  async run(): Promise<SetupCustomDomainResult> {
    try {
      if (this.input.tenantId !== undefined) this.tenantTag = await this.deps.ownership!.tenantTag(this.input.tenantId);
      await this.step('validate', async () => ({
        status: 'succeeded',
        message: `Onboarding ${this.hostnames.join(', ')} with ${this.strategy}`,
      }));
      await this.step('registration', () => this.registrationStep());
      await this.step('zone', () => this.zoneStep());
      await this.step('ownership', () => this.ownershipStep());
      await this.step('nameservers', () => this.nameserverStep());
      await this.step('dns', () => this.dnsStep());
      await this.step('routing', () => this.routingStep());
      await this.step('verification', () => this.verificationStep());
    } catch (error) {
      if (!(error instanceof StopWorkflow)) throw error;
    }
    return this.result();
  }

  // ---------------------------------------------------------------- steps

  private async registrationStep(): Promise<StepOutcome> {
    const reg = this.input.registration;
    const existing = this.state.resources.registration;
    if (!reg) return { status: 'skipped', message: 'No purchase requested' };
    const registrar = this.deps.registrar!;
    if (existing && (existing.status === 'registered' || existing.status === 'already-owned')) {
      return { status: 'succeeded', message: `${this.domain} was registered by a previous run` };
    }

    const accepted = existing?.status === 'pending' || existing?.status === 'action-required';
    if (existing && (accepted || existing.status === 'submitting' || existing.status === 'unknown')) {
      // A previous run sent (or may have sent) the purchase. Never buy twice.
      if (supports(registrar, 'getDomain')) {
        const owned = await registrar.getDomain!(this.domain, this.signal);
        if (owned) {
          this.state.resources.registration = {
            ...existing,
            status: 'registered',
            ...(owned.expiresAt ? { expiresAt: owned.expiresAt } : {}),
          };
          return {
            status: 'succeeded',
            message: `${this.domain} is registered in the ${registrar.displayName} account`,
          };
        }
      }
      if (accepted) {
        // The registrar accepted the order earlier; repeating it could buy twice. Keep waiting.
        return {
          status: 'waiting',
          message: `Registration of ${this.domain} is still ${existing.status} at the registrar`,
          actions: [registrationAction(existing.status as 'pending' | 'action-required')],
        };
      }
      const age = existing.submittedAt ? Date.now() - Date.parse(existing.submittedAt) : Infinity;
      if (!registrar.capabilities.idempotentRegistration || age > IDEMPOTENCY_WINDOW_MS) {
        throw new PurchaseError(
          'PURCHASE_OUTCOME_UNKNOWN',
          `A previous purchase of ${this.domain} has an unknown outcome and cannot be safely repeated automatically. ` +
            `Check the registrar's order history, then start a new workflow without resumeFrom if it was not charged.`,
          { provider: registrar.id, details: { idempotencyKey: existing.idempotencyKey } },
        );
      }
    }

    if (this.dryRun) {
      return {
        status: 'planned',
        message: 'Would purchase the domain (dry run checks availability and price only)',
        planned: [
          {
            operation: 'registrar.register',
            target: this.domain,
            details: { years: reg.years ?? 1, maxPrice: reg.maxPrice },
          },
        ],
      };
    }

    const idempotencyKey = existing?.idempotencyKey ?? randomId();
    this.state.resources.registration = {
      status: 'submitting',
      idempotencyKey,
      submittedAt: existing?.submittedAt ?? now(),
    };
    // Persist the key before money can move. If this fails, do not purchase.
    await this.checkpoint(true);

    try {
      const result = await this.deps.registration!.purchase({
        domain: this.domain,
        maxPrice: reg.maxPrice,
        idempotencyKey,
        ...(reg.years === undefined ? {} : { years: reg.years }),
        ...(reg.allowPremium === undefined ? {} : { allowPremium: reg.allowPremium }),
        ...(reg.contacts ? { contacts: reg.contacts } : {}),
        ...(reg.privacy === undefined ? {} : { privacy: reg.privacy }),
        ...(reg.autoRenew === undefined ? {} : { autoRenew: reg.autoRenew }),
        ...this.signal,
      });
      // Record what the registrar actually reported: a pending order is not a registration.
      this.state.resources.registration = {
        status: result.status,
        idempotencyKey,
        submittedAt: this.state.resources.registration.submittedAt!,
        ...(result.orderId ? { orderId: result.orderId } : {}),
        ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
      };
      if (result.status === 'pending' || result.status === 'action-required') {
        return {
          status: 'waiting',
          message: `Registration is ${result.status} at the registrar`,
          actions: [registrationAction(result.status)],
        };
      }
      return {
        status: 'succeeded',
        message:
          result.status === 'already-owned'
            ? 'Domain already in the registrar account; nothing purchased'
            : `Registered (order ${result.orderId ?? 'n/a'})`,
      };
    } catch (error) {
      const unknown = isDomainPilotError(error, 'PURCHASE_OUTCOME_UNKNOWN');
      this.state.resources.registration = {
        ...this.state.resources.registration,
        status: unknown ? 'unknown' : 'failed',
      };
      if (!unknown) {
        // Nothing was purchased; drop the key so a corrected retry uses a new one.
        delete this.state.resources.registration;
      }
      throw error;
    }
  }

  private async zoneStep(): Promise<StepOutcome> {
    const { cloudflare } = this.deps;
    if (this.strategy === 'saas-custom-hostname') {
      const r = this.routing as Extract<RoutingSpec, { strategy: 'saas-custom-hostname' }>;
      const zone = await cloudflare.zones.get(r.saasZoneId, this.signal);
      this.zone = zone;
      if (zone.status !== 'active') {
        throw new DomainPilotError(
          'CONFIGURATION_ERROR',
          `SaaS zone ${zone.name} must be active before onboarding tenants`,
          { details: { zoneId: zone.id } },
        );
      }
      return { status: 'succeeded', message: `Using SaaS zone ${zone.name}` };
    }

    const existing = await cloudflare.zones.find(this.zoneName, this.signal);
    if (existing) {
      this.zone = existing;
      const createdBefore =
        this.state.resources.zone?.id === existing.id && this.state.resources.zone.createdByWorkflow;
      this.saveZone(existing, createdBefore);
      return { status: 'succeeded', message: `Reusing zone ${existing.name} (${existing.status})` };
    }
    if (!this.isOwnZone) {
      throw new DomainPilotError('NOT_FOUND', `Zone ${this.zoneName} does not exist in the Cloudflare account`, {
        details: { zone: this.zoneName },
      });
    }
    if (this.dryRun) {
      return {
        status: 'planned',
        message: 'Would create a Cloudflare zone',
        planned: [{ operation: 'cloudflare.zones.create', target: this.zoneName }],
      };
    }
    const created = await cloudflare.zones.create({ domain: this.zoneName, ...this.signal });
    this.zone = created;
    this.saveZone(created, created.created);
    return {
      status: 'succeeded',
      message: created.created ? `Created zone ${created.name}` : `Reusing zone ${created.name}`,
    };
  }

  private async ownershipStep(): Promise<StepOutcome> {
    const tenantId = this.input.tenantId;
    if (tenantId === undefined) return { status: 'skipped', message: 'No tenantId supplied' };
    const ownership = this.deps.ownership!;

    if (this.strategy === 'saas-custom-hostname') {
      // The tenant must publish a tenant-bound TXT record before the hostname is created on
      // the SaaS zone; this prevents another tenant from claiming the hostname first.
      const actions: OutstandingAction[] = [];
      for (const hostname of this.hostnames) {
        const result = await ownership.verifyChallenge({ hostname, tenantId, ...this.signal });
        if (result.status === 'failed') {
          throw new TenantConflictError(`${hostname} publishes an ownership record for a different tenant`, {
            hostname,
          });
        }
        if (result.status !== 'passed') {
          actions.push({
            type: 'add-dns-record',
            owner: 'tenant',
            record: result.record,
            instructions: `Ask the tenant to add TXT ${result.record.name} = ${result.record.content}, then resume the workflow.`,
          });
        }
      }
      return actions.length
        ? { status: 'waiting', message: 'Waiting for the tenant to publish the ownership record', actions }
        : { status: 'succeeded', message: 'Tenant ownership verified for every hostname' };
    }

    // Zone strategies: the marker lives in the zone at _domainpilot.<domain>.
    const challenge = await ownership.createChallenge({ hostname: this.domain, tenantId });
    if (!this.zone) {
      return {
        status: 'planned',
        message: 'Would create the tenant ownership marker',
        planned: [{ operation: 'cloudflare.dns.create', target: challenge.record.name, details: { type: 'TXT' } }],
      };
    }
    const records = await this.deps.cloudflare.dns.list({
      zoneId: this.zone.id,
      name: challenge.record.name,
      type: 'TXT',
      ...this.signal,
    });
    const markers = records.filter((r) => ownership.isChallengeValue(r.content));
    const mine: DnsRecord[] = [];
    const others: DnsRecord[] = [];
    for (const r of markers) {
      if (await ownership.matches(r.content, this.domain, tenantId)) mine.push(r);
      else others.push(r);
    }
    if (others.length && !this.input.reassign?.allowed) {
      throw new TenantConflictError(
        `${this.domain} is already claimed by a different tenant; pass reassign.allowed only after verifying the transfer`,
        {
          domain: this.domain,
        },
      );
    }
    const planned: PlannedChange[] = [];
    for (const other of others) {
      if (this.dryRun)
        planned.push({ operation: 'cloudflare.dns.delete', target: other.name, details: { reason: 'reassign' } });
      else
        await this.deps.cloudflare.dns.delete({
          zoneId: this.zone.id,
          recordId: other.id,
          confirm: true,
          ...this.signal,
        });
    }
    if (mine[0]) {
      this.state.resources.ownershipRecordId = mine[0].id;
      return planned.length
        ? { status: 'planned', message: 'Would remove the previous tenant marker', planned }
        : { status: 'succeeded', message: 'Ownership marker for this tenant is present' };
    }

    const createdByWorkflow = this.state.resources.zone?.createdByWorkflow === true;
    if (this.isOwnZone && !createdByWorkflow && !this.input.zone?.adoptExisting && !others.length) {
      throw new TenantConflictError(
        `Zone ${this.zoneName} already existed and has no ownership marker for this tenant. Confirm the zone belongs to the tenant, then pass zone.adoptExisting: true`,
        { zone: this.zoneName },
      );
    }
    if (this.dryRun) {
      planned.push({ operation: 'cloudflare.dns.create', target: challenge.record.name, details: { type: 'TXT' } });
      return { status: 'planned', message: 'Would create the tenant ownership marker', planned };
    }
    const created = await this.deps.cloudflare.dns.create({
      zoneId: this.zone.id,
      type: 'TXT',
      name: challenge.record.name,
      content: challenge.record.content,
      ...(this.tenantTag ? { tenantTag: this.tenantTag } : {}),
      ...this.signal,
    });
    this.state.resources.ownershipRecordId = created.id;
    this.trackRecord(created, created.created);
    return { status: 'succeeded', message: 'Created the tenant ownership marker' };
  }

  private async nameserverStep(): Promise<StepOutcome> {
    if (this.strategy === 'saas-custom-hostname')
      return { status: 'skipped', message: 'Tenant keeps DNS at their provider' };
    if (!this.isOwnZone) return { status: 'skipped', message: `Served from the existing zone ${this.zoneName}` };
    const zone = this.zone;
    if (!zone) return { status: 'planned', message: 'Nameservers are known once the zone exists' };
    if (zone.status === 'active') return { status: 'succeeded', message: 'Zone is active; nameservers are delegated' };

    const registrar = this.deps.registrar;
    const registered =
      registrar && supports(registrar, 'getDomain') ? await registrar.getDomain!(this.domain, this.signal) : null;
    const canAutomate = Boolean(registrar && registered && supports(registrar, 'setNameservers'));
    const action: OutstandingAction = {
      type: 'update-nameservers',
      domain: this.domain,
      nameservers: zone.nameservers,
      ...(registered ? { currentNameservers: registered.nameservers } : {}),
      automatable: canAutomate,
      instructions:
        `Set the nameservers for ${this.domain} at its registrar to ${zone.nameservers.join(' and ')}.` +
        (canAutomate ? ' DomainPilot can do this when nameservers.updateAtRegistrar is true.' : ''),
    };

    if (registered && sameNameservers(registered.nameservers, zone.nameservers)) {
      return {
        status: 'waiting',
        message: 'Registrar already uses the Cloudflare nameservers; waiting for activation',
        actions: [{ type: 'wait', reason: 'Zone activation' }],
      };
    }
    if (canAutomate && this.input.nameservers?.updateAtRegistrar === true) {
      if (this.dryRun) {
        return {
          status: 'planned',
          message: 'Would update nameservers at the registrar',
          planned: [
            { operation: 'registrar.setNameservers', target: this.domain, details: { nameservers: zone.nameservers } },
          ],
        };
      }
      await this.deps.registration!.setNameservers({
        domain: this.domain,
        nameservers: zone.nameservers,
        confirm: true,
        ...this.signal,
      });
      try {
        await this.deps.cloudflare.zones.triggerActivationCheck(zone.id, this.signal);
      } catch (error) {
        this.deps.logger.warn('activation check request failed; Cloudflare will re-check on its own schedule', {
          code: serializeError(error).code,
        });
      }
      return {
        status: 'waiting',
        message: 'Updated nameservers at the registrar; waiting for delegation',
        actions: [{ type: 'wait', reason: 'Nameserver propagation' }],
      };
    }
    return { status: 'waiting', message: 'Nameservers must be changed at the registrar', actions: [action] };
  }

  private async dnsStep(): Promise<StepOutcome> {
    if (this.strategy === 'saas-custom-hostname') {
      const target = normalizeHostname(
        (this.routing as Extract<RoutingSpec, { strategy: 'saas-custom-hostname' }>).cnameTarget,
      );
      return {
        status: 'waiting',
        message: 'The tenant must point their hostnames at the platform',
        actions: this.hostnames.map((hostname) => ({
          type: 'add-dns-record' as const,
          owner: 'tenant' as const,
          record: { type: 'CNAME', name: hostname, content: target },
          instructions: `Create CNAME ${hostname} -> ${target} at the tenant's DNS provider (apex names need CNAME flattening or ALIAS).`,
        })),
      };
    }
    const zone = this.zone;
    const planned: PlannedChange[] = [];
    if (!zone) {
      for (const hostname of this.hostnames)
        if (this.strategy === 'route')
          planned.push({
            operation: 'cloudflare.dns.create',
            target: hostname,
            details: { type: 'AAAA', content: '100::', proxied: true },
          });
      for (const record of this.input.dns?.records ?? [])
        planned.push({ operation: 'cloudflare.dns.create', target: record.name, details: { type: record.type } });
      return { status: 'planned', message: 'Would configure DNS records', planned };
    }

    const { dns } = this.deps.cloudflare;
    const actions: OutstandingAction[] = [];
    for (const hostname of this.hostnames) {
      const existing = (await dns.list({ zoneId: zone.id, name: hostname, ...this.signal })).filter((r) =>
        ADDRESS_TYPES.has(r.type),
      );
      if (this.strategy === 'custom-domain') {
        const attached = await this.deps.cloudflare.workers.customDomains.findByHostname(hostname, this.signal);
        if (attached || !existing.length) continue;
        const conflicts = await this.clearManagedConflicts(zone.id, existing, planned);
        if (conflicts.length) actions.push(this.conflictAction(hostname, conflicts));
        continue;
      }
      // Workers Routes need a proxied record; an existing proxied record is reused as-is.
      if (existing.some((r) => r.proxied)) continue;
      const conflicts = await this.clearManagedConflicts(zone.id, existing, planned);
      if (conflicts.length) {
        actions.push(this.conflictAction(hostname, conflicts));
        continue;
      }
      if (this.dryRun) {
        planned.push({
          operation: 'cloudflare.dns.create',
          target: hostname,
          details: { type: 'AAAA', content: '100::', proxied: true },
        });
        continue;
      }
      const created = await dns.create({
        zoneId: zone.id,
        type: 'AAAA',
        name: hostname,
        content: '100::',
        proxied: true,
        comment: 'Originless record for Workers Routes',
        ...(this.tenantTag ? { tenantTag: this.tenantTag } : {}),
        ...this.signal,
      });
      this.trackRecord(created, created.created);
    }

    for (const record of this.input.dns?.records ?? []) {
      if (this.dryRun) {
        planned.push({ operation: 'cloudflare.dns.create', target: record.name, details: { type: record.type } });
        continue;
      }
      const created = await dns.create({
        zoneId: zone.id,
        ...record,
        ...(this.tenantTag ? { tenantTag: this.tenantTag } : {}),
        ...this.signal,
      });
      this.trackRecord(created, created.created);
    }

    if (actions.length) {
      throw Object.assign(
        new DomainPilotError(
          'CONFLICT',
          'Existing DNS records conflict with the requested routing; resolve them and resume',
          {
            details: { hostnames: actions.map((a) => (a.type === 'resolve-dns-conflict' ? a.hostname : '')) },
          },
        ),
        { actions },
      );
    }
    if (this.dryRun && planned.length) return { status: 'planned', message: 'Would configure DNS records', planned };
    return { status: 'succeeded', message: 'DNS records configured' };
  }

  private async routingStep(): Promise<StepOutcome> {
    const { cloudflare } = this.deps;
    const allowReassign = this.input.reassign?.allowed === true;
    const zone = this.zone;
    if (this.strategy === 'saas-custom-hostname') {
      const r = this.routing as Extract<RoutingSpec, { strategy: 'saas-custom-hostname' }>;
      if (this.input.tenantId !== undefined && this.record('ownership').status !== 'succeeded') {
        return {
          status: 'waiting',
          message: 'Custom hostnames are created only after tenant ownership is verified',
          actions: [{ type: 'wait', reason: 'Tenant ownership verification' }],
        };
      }
      const planned: PlannedChange[] = [];
      for (const hostname of this.hostnames) {
        if (this.dryRun) {
          const found = await cloudflare.customHostnames.find(r.saasZoneId, hostname, this.signal);
          if (!found) planned.push({ operation: 'cloudflare.customHostnames.create', target: hostname });
          continue;
        }
        const created = await cloudflare.customHostnames.create({ zoneId: r.saasZoneId, hostname, ...this.signal });
        this.upsert(
          this.state.resources.customHostnames,
          { id: created.id, zoneId: r.saasZoneId, hostname },
          (x) => x.hostname === hostname,
        );
      }
      if (planned.length) return { status: 'planned', message: 'Would create custom hostnames', planned };
      return { status: 'succeeded', message: 'Custom hostnames exist on the SaaS zone' };
    }

    if (!zone) {
      return {
        status: 'planned',
        message: 'Would connect the hostnames to the Worker',
        planned: this.hostnames.map((h) => ({
          operation:
            this.strategy === 'route' ? 'cloudflare.workers.routes.create' : 'cloudflare.workers.customDomains.attach',
          target: h,
          details: { service: this.service },
        })),
      };
    }
    const planned: PlannedChange[] = [];
    for (const hostname of this.hostnames) {
      if (this.strategy === 'custom-domain') {
        if (this.dryRun) {
          const found = await cloudflare.workers.customDomains.findByHostname(hostname, this.signal);
          if (found && found.service !== this.service && !allowReassign) {
            throw new TenantConflictError(`${hostname} is attached to a different Worker`, {
              hostname,
              currentService: found.service,
            });
          }
          if (!found || found.service !== this.service)
            planned.push({
              operation: 'cloudflare.workers.customDomains.attach',
              target: hostname,
              details: { service: this.service },
            });
          continue;
        }
        const attached = await cloudflare.workers.customDomains.attach({
          hostname,
          service: this.service,
          zoneId: zone.id,
          allowReassign,
          ...this.signal,
        });
        this.upsert(
          this.state.resources.customDomains,
          { id: attached.id, hostname, service: attached.service },
          (x) => x.hostname === hostname,
        );
      } else {
        const pattern = `${hostname}/*`;
        if (this.dryRun) {
          const routes = await cloudflare.workers.routes.list(zone.id, this.signal);
          const found = routes.find((x) => x.pattern === pattern);
          if (found && found.script !== this.service && !allowReassign) {
            throw new TenantConflictError(`Route ${pattern} points to a different Worker`, {
              pattern,
              currentScript: found.script,
            });
          }
          if (!found || found.script !== this.service)
            planned.push({
              operation: 'cloudflare.workers.routes.create',
              target: pattern,
              details: { script: this.service },
            });
          continue;
        }
        const route = await cloudflare.workers.routes.create({
          zoneId: zone.id,
          pattern,
          script: this.service,
          allowReassign,
          ...this.signal,
        });
        this.upsert(
          this.state.resources.routes,
          { id: route.id, zoneId: zone.id, pattern, script: this.service },
          (x) => x.pattern === pattern,
        );
      }
    }
    if (planned.length) return { status: 'planned', message: 'Would connect the hostnames to the Worker', planned };
    return { status: 'succeeded', message: `Hostnames routed to Worker "${this.service}"` };
  }

  private async verificationStep(): Promise<StepOutcome> {
    if (this.dryRun) return { status: 'planned', message: 'Verification runs after the changes are applied' };
    const v = this.input.verification ?? {};
    const report = await this.deps.verifier.verify({
      domain: this.domain,
      hostnames: this.hostnames,
      ...(this.isOwnZone || this.strategy === 'saas-custom-hostname' ? {} : { zone: this.zoneName }),
      ...(this.input.tenantId === undefined ? {} : { tenantId: this.input.tenantId }),
      routing: this.routing,
      worker: { name: this.service, service: this.service },
      ...(v.https === undefined ? {} : { https: v.https }),
      ...(v.waitForReady ? { waitForReady: true } : {}),
      ...(v.timeoutMs === undefined ? {} : { timeoutMs: v.timeoutMs }),
      ...(v.intervalMs === undefined ? {} : { intervalMs: v.intervalMs }),
      ...this.signal,
    });
    this.verification = report;
    if (report.verified) return { status: 'succeeded', message: 'Every required check passed' };
    if (report.summary === 'failed') {
      throw Object.assign(
        new DomainPilotError(
          'PROVIDER_ERROR',
          `Verification failed: ${report.errors.map((e) => `${e.check}${e.hostname ? ` (${e.hostname})` : ''}: ${e.message}`).join('; ')}`,
          {
            details: { failedChecks: report.errors.map((e) => e.check) },
          },
        ),
        { actions: report.outstandingActions },
      );
    }
    return {
      status: 'waiting',
      message: report.timedOut
        ? 'Not ready before the verification timeout'
        : 'Waiting for propagation, issuance or outstanding actions',
      actions: report.outstandingActions,
    };
  }

  // ---------------------------------------------------------------- helpers

  private async clearManagedConflicts(
    zoneId: string,
    records: DnsRecord[],
    planned: PlannedChange[],
  ): Promise<DnsRecord[]> {
    const removable = this.input.dns?.replaceManagedRecords === true;
    const remaining: DnsRecord[] = [];
    for (const r of records) {
      const ours = r.managed && r.tenantTag === (this.tenantTag ?? null);
      if (removable && ours) {
        if (this.dryRun)
          planned.push({
            operation: 'cloudflare.dns.delete',
            target: r.name,
            details: { type: r.type, content: r.content },
          });
        else await this.deps.cloudflare.dns.delete({ zoneId, recordId: r.id, confirm: true, ...this.signal });
      } else {
        remaining.push(r);
      }
    }
    return remaining;
  }

  private conflictAction(hostname: string, records: DnsRecord[]): OutstandingAction {
    const managed = records.every((r) => r.managed && r.tenantTag === (this.tenantTag ?? null));
    return {
      type: 'resolve-dns-conflict',
      hostname,
      records: records.map((r) => ({ id: r.id, type: r.type, content: r.content })),
      instructions: managed
        ? `Records at ${hostname} were created by DomainPilot for this tenant; pass dns.replaceManagedRecords: true to replace them.`
        : `Records at ${hostname} were not created by DomainPilot. Remove or change them deliberately (cloudflare.dns.delete with allowUnmanaged) before routing this hostname.`,
    };
  }

  private saveZone(zone: Zone, createdByWorkflow: boolean): void {
    this.state.resources.zone = {
      id: zone.id,
      name: zone.name,
      nameservers: zone.nameservers,
      status: zone.status,
      createdByWorkflow,
    };
  }

  private trackRecord(record: DnsRecord, created: boolean): void {
    const list = this.state.resources.dnsRecords;
    const prior = list.find((r) => r.id === record.id);
    if (prior) prior.createdByWorkflow = prior.createdByWorkflow || created;
    else list.push({ id: record.id, name: record.name, type: record.type, createdByWorkflow: created });
  }

  private upsert<T>(list: T[], item: T, same: (x: T) => boolean): void {
    const index = list.findIndex(same);
    if (index >= 0) list[index] = item;
    else list.push(item);
  }

  private record(id: SetupStepId): StepRecord<SetupStepId> {
    return this.state.steps.find((s) => s.id === id)!;
  }

  private async step(id: SetupStepId, fn: () => Promise<StepOutcome>): Promise<void> {
    const record = this.record(id);
    if (
      id === 'registration' &&
      (record.status === 'succeeded' || record.status === 'skipped') &&
      this.input.resumeFrom
    )
      return;
    record.startedAt = now();
    let stop = false;
    try {
      const outcome = await fn();
      record.status = outcome.status;
      if (outcome.message !== undefined) record.message = outcome.message;
      if (outcome.actions?.length) record.actions = outcome.actions;
      if (outcome.planned?.length) record.planned = outcome.planned;
    } catch (error) {
      if (error instanceof StopWorkflow) throw error;
      record.status = 'failed';
      record.error = serializeError(error);
      record.message = record.error.message;
      const actions = (error as { actions?: OutstandingAction[] }).actions;
      if (actions?.length) record.actions = actions;
      stop = true;
      if (isDomainPilotError(error, 'ABORTED')) this.deps.logger.info('workflow cancelled', { step: id });
    }
    record.finishedAt = now();
    await this.checkpoint(false);
    if (stop) throw new StopWorkflow();
  }

  private async checkpoint(beforePurchase: boolean): Promise<void> {
    this.state.updatedAt = now();
    this.state.lifecycle = deriveLifecycle(this.state.steps);
    if (!this.input.onCheckpoint || this.dryRun) return;
    try {
      await this.input.onCheckpoint(JSON.parse(JSON.stringify(this.state)) as SetupWorkflowState);
    } catch (error) {
      this.checkpointError = new DomainPilotError(
        'CONFIGURATION_ERROR',
        'onCheckpoint failed; the workflow stopped so progress is not lost',
        {
          cause: error,
          details: { beforePurchase },
        },
      );
      if (beforePurchase) {
        delete this.state.resources.registration;
        throw this.checkpointError;
      }
      throw new StopWorkflow();
    }
  }

  private result(): SetupCustomDomainResult {
    this.state.lifecycle = deriveLifecycle(this.state.steps);
    const errors = this.state.steps.filter((s) => s.error).map((s) => ({ ...s.error!, step: s.id }));
    if (this.checkpointError) errors.push({ ...this.checkpointError.toJSON(), step: 'validate' });
    const outstandingActions = this.verification?.outstandingActions.length
      ? this.verification.outstandingActions
      : this.state.steps.flatMap((s) => s.actions ?? []);
    return {
      domain: this.domain,
      hostnames: this.hostnames,
      lifecycle: this.state.lifecycle,
      ready: this.verification?.verified === true,
      dryRun: this.dryRun,
      steps: this.state.steps,
      ...(this.verification ? { verification: this.verification } : {}),
      outstandingActions,
      errors,
      state: JSON.parse(JSON.stringify(this.state)) as SetupWorkflowState,
    };
  }
}
