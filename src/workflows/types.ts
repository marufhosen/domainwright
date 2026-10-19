import type { DnsRecordInput } from '../cloudflare/dns.js';
import type { SerializedError } from '../core/errors.js';
import type {
  DomainLifecycleState,
  OutstandingAction,
  RequestOptions,
  RoutingStrategy,
  WorkerTarget,
} from '../core/types.js';
import type { SpendingLimit } from '../domains/registration.js';
import type { RegistrantContact } from '../registrars/types.js';
import type { HttpsExpectation } from '../verification/reachability.js';
import type { RoutingSpec, VerificationReport } from '../verification/types.js';

export type SetupStepId =
  'validate' | 'registration' | 'zone' | 'ownership' | 'nameservers' | 'dns' | 'routing' | 'verification';

/**
 * - `pending`: not started.
 * - `succeeded`: completed (resources exist or were confirmed).
 * - `skipped`: not applicable to this request.
 * - `waiting`: done as far as DomainPilot can go; waiting on propagation or an outstanding action.
 * - `failed`: stopped with an error (see `error.retryable`).
 * - `planned`: dry run; the listed changes would be made.
 */
export type StepStatus = 'pending' | 'succeeded' | 'skipped' | 'waiting' | 'failed' | 'planned';

export interface PlannedChange {
  operation: string;
  target: string;
  details?: Record<string, unknown>;
}

export interface StepRecord<Id extends string = string> {
  id: Id;
  status: StepStatus;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: SerializedError;
  actions?: OutstandingAction[];
  planned?: PlannedChange[];
}

export interface RegistrationState {
  /** `submitting` is persisted *before* the purchase request is sent. */
  status: 'submitting' | 'registered' | 'already-owned' | 'unknown' | 'failed';
  idempotencyKey: string;
  submittedAt?: string;
  orderId?: string;
  expiresAt?: string;
}

/** Provider resources the workflow created or confirmed. JSON-serializable. */
export interface WorkflowResources {
  zone?: { id: string; name: string; nameservers: string[]; status: string; createdByWorkflow: boolean };
  registration?: RegistrationState;
  ownershipRecordId?: string;
  dnsRecords: { id: string; name: string; type: string; createdByWorkflow: boolean }[];
  customDomains: { id: string; hostname: string; service: string }[];
  routes: { id: string; zoneId: string; pattern: string; script: string }[];
  customHostnames: { id: string; zoneId: string; hostname: string }[];
}

/**
 * Persist this object (it is plain JSON) and pass it back as `resumeFrom` to continue an
 * interrupted or pending onboarding without repeating purchases or duplicating resources.
 */
export interface SetupWorkflowState {
  version: 1;
  workflow: 'setup-custom-domain';
  domain: string;
  tenantId: string | null;
  hostnames: string[];
  strategy: RoutingStrategy;
  service: string;
  lifecycle: DomainLifecycleState;
  steps: StepRecord<SetupStepId>[];
  resources: WorkflowResources;
  createdAt: string;
  updatedAt: string;
}

export interface HostnameSelection {
  /** Serve the domain itself. Default true. */
  root?: boolean;
  /** Serve `www.<domain>`. Default false. */
  www?: boolean;
  /** Additional labels under the domain, e.g. `['app', 'shop']`. */
  subdomains?: string[];
}

export interface SetupCustomDomainInput extends RequestOptions {
  /** Domain to connect: an apex (`example.com`) or a tenant subdomain (`tenant-a.example.com`). */
  domain: string;
  /** Tenant the domain belongs to. Enables tenant-bound ownership markers and challenges. */
  tenantId?: string;
  /** Worker that must serve the domain. DomainPilot never deploys or modifies Worker code. */
  worker: WorkerTarget;
  /** Routing strategy. Default `{ strategy: 'custom-domain' }`. */
  routing?: RoutingSpec;
  /** Hostnames to serve and extra records to create. */
  dns?: HostnameSelection & {
    /** Additional records to create in the zone (zone strategies only). */
    records?: DnsRecordInput[];
    /**
     * Delete conflicting A/AAAA/CNAME records at the hostnames when they carry this tenant's
     * DomainPilot marker. Unmanaged records are never deleted. Default false.
     */
    replaceManagedRecords?: boolean;
  };
  /** Zone selection for zone strategies. */
  zone?: {
    /** Existing zone that contains `domain`, when `domain` is a subdomain. Default: `domain`. */
    name?: string;
    /**
     * Use a pre-existing zone that has no ownership marker for this tenant. Only set after
     * confirming the zone belongs to the tenant. Default false.
     */
    adoptExisting?: boolean;
  };
  /** Register the domain first. Purchases happen only when this is present. */
  registration?: {
    purchase: true;
    years?: number;
    maxPrice: SpendingLimit | number;
    allowPremium?: boolean;
    contacts?: {
      registrant?: RegistrantContact;
      admin?: RegistrantContact;
      tech?: RegistrantContact;
      billing?: RegistrantContact;
    };
    privacy?: boolean;
    autoRenew?: boolean;
  };
  nameservers?: {
    /**
     * Authorize DomainPilot to set the Cloudflare nameservers at the registrar when the domain is
     * in the configured registrar account. Default false: instructions are returned instead.
     */
    updateAtRegistrar?: boolean;
  };
  /**
   * Allow moving hostnames that are attached to a different Worker, or whose ownership marker
   * belongs to a different tenant. Default false.
   */
  reassign?: { allowed: boolean };
  verification?: {
    /** Poll until ready (or a permanent failure / timeout). Default false. */
    waitForReady?: boolean;
    timeoutMs?: number;
    intervalMs?: number;
    https?: HttpsExpectation | false;
  };
  /** Report the changes that would be made without making them. */
  dryRun?: boolean;
  /** State returned by a previous run. */
  resumeFrom?: SetupWorkflowState;
  /**
   * Called with the latest state after every step and before any purchase is submitted.
   * Persist it; if it throws before a purchase, the purchase is not attempted.
   */
  onCheckpoint?: (state: SetupWorkflowState) => void | Promise<void>;
}

export interface SetupCustomDomainResult {
  domain: string;
  hostnames: string[];
  lifecycle: DomainLifecycleState;
  /** True only when verification passed every required check. */
  ready: boolean;
  dryRun: boolean;
  steps: StepRecord<SetupStepId>[];
  verification?: VerificationReport;
  outstandingActions: OutstandingAction[];
  errors: (SerializedError & { step: SetupStepId })[];
  state: SetupWorkflowState;
}

export type RemovalStepId = 'validate' | 'tenant' | 'routing' | 'dns' | 'zone';

export interface RemoveCustomDomainInput extends RequestOptions {
  domain: string;
  tenantId?: string;
  /** Only detach routing that points at this Worker. Strongly recommended. */
  worker?: WorkerTarget;
  routing?: RoutingSpec;
  dns?: HostnameSelection;
  zone?: { name?: string };
  /** Also delete the zone when it contains only DomainPilot-managed records. Default false. */
  deleteZone?: boolean;
  /** Required unless `dryRun` is set. */
  confirm?: boolean;
  dryRun?: boolean;
}

export interface RemoveCustomDomainResult {
  domain: string;
  hostnames: string[];
  /** `disabled` after a complete removal; `unchanged` for a dry run. */
  lifecycle: Extract<DomainLifecycleState, 'disabled' | 'failed'> | 'unchanged';
  dryRun: boolean;
  steps: StepRecord<RemovalStepId>[];
  removed: {
    customDomains: string[];
    routes: string[];
    customHostnames: string[];
    dnsRecords: string[];
    zone: string | null;
  };
  /** Resources deliberately left in place, with the reason. */
  retained: { resource: string; reason: string }[];
  errors: (SerializedError & { step: RemovalStepId })[];
}

export interface DomainStatusResult {
  domain: string;
  lifecycle: DomainLifecycleState;
  verification: VerificationReport;
}
