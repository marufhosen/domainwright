/**
 * Shared, provider-independent types.
 */

/**
 * Lifecycle of a tenant domain as reported by DomainPilot.
 *
 * - `pending`: nothing has been provisioned yet, or the workflow has not started.
 * - `registering`: a registrar purchase is in progress or awaiting registry completion.
 * - `configuring`: provider resources (zone, DNS records, Worker routing) are being created,
 *   or an outstanding action blocks configuration (for example a DNS conflict).
 * - `verifying`: resources exist; waiting for nameserver delegation, DNS propagation,
 *   ownership verification, certificate issuance or reachability.
 * - `active`: every required verification check passed. Only this state means the
 *   domain is ready to serve production traffic.
 * - `failed`: a permanent failure that needs intervention (see the step errors).
 * - `disabled`: the domain was disconnected by the removal workflow.
 */
export type DomainLifecycleState =
  'pending' | 'registering' | 'configuring' | 'verifying' | 'active' | 'failed' | 'disabled';

/** The mechanism used to send a hostname's traffic to a Worker. */
export type RoutingStrategy =
  /**
   * Workers Custom Domains (`PUT /accounts/{id}/workers/domains`). Cloudflare creates the
   * DNS record and certificate. Requires the hostname's zone to be in the configured account.
   */
  | 'custom-domain'
  /**
   * Workers Routes (`POST /zones/{id}/workers/routes`) plus a proxied DNS record for each
   * hostname. Requires the zone to be in the configured account.
   */
  | 'route'
  /**
   * Cloudflare for SaaS custom hostnames on the platform's own zone. The tenant keeps DNS at
   * their provider and adds a CNAME to the platform's target; a Worker route on the SaaS zone
   * (for example `*\/*`) serves the traffic.
   */
  | 'saas-custom-hostname';

/** Identifies the Worker that should serve a domain. */
export interface WorkerTarget {
  /** Worker name as deployed (the `name` in wrangler configuration). */
  name: string;
  /**
   * Optional Wrangler environment. Wrangler deploys environment `env` of Worker `name` as a
   * separate Worker named `name-env`, which is the service DomainPilot targets. Cloudflare's
   * `environment` field on Workers Custom Domains is deprecated, so it is not sent.
   */
  environment?: string;
  /** Explicit service (script) name. Overrides `name`/`environment` resolution. */
  service?: string;
}

export function resolveWorkerService(worker: WorkerTarget): string {
  if (worker.service) return worker.service;
  return worker.environment ? `${worker.name}-${worker.environment}` : worker.name;
}

/**
 * Status of a single verification check.
 *
 * - `passed`: verified.
 * - `pending`: not yet satisfied, but expected to resolve with time (propagation, issuance).
 * - `failed`: definitively misconfigured; will not resolve without a change.
 * - `blocked`: cannot be evaluated until an earlier check passes.
 * - `error`: the check could not be completed (provider or network error); retry later.
 * - `skipped`: not applicable to this configuration.
 */
export type CheckStatus = 'passed' | 'pending' | 'failed' | 'blocked' | 'error' | 'skipped';

export type CheckId =
  | 'registration'
  | 'zone'
  | 'nameservers'
  | 'zone-activation'
  | 'ownership'
  | 'dns-records'
  | 'routing'
  | 'certificate'
  | 'dns-resolution'
  | 'https';

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  /** Whether this check must pass for the domain to be considered ready. */
  required: boolean;
  /** Hostname the check applies to, for per-hostname checks. */
  hostname?: string;
  message: string;
  /** Machine-readable, non-sensitive details. */
  details?: Record<string, unknown>;
  /** Something the caller (or the tenant) must do for this check to pass. */
  action?: OutstandingAction;
}

/** Work that DomainPilot cannot (or was not authorized to) perform itself. */
export type OutstandingAction =
  | {
      type: 'update-nameservers';
      domain: string;
      nameservers: string[];
      currentNameservers?: string[];
      /** Whether the configured registrar adapter could do this if authorized. */
      automatable: boolean;
      instructions: string;
    }
  | {
      type: 'add-dns-record';
      /** Who must create the record: the tenant at their DNS provider, or the platform. */
      owner: 'tenant' | 'platform';
      record: { type: string; name: string; content: string };
      instructions: string;
    }
  | {
      type: 'resolve-dns-conflict';
      hostname: string;
      records: { id: string; type: string; content: string }[];
      instructions: string;
    }
  | { type: 'configure-worker-route'; zone: string; pattern: string; service: string; instructions: string }
  | { type: 'wait'; reason: string }
  | { type: 'manual'; instructions: string };

/** Options shared by operations that call providers. */
export interface RequestOptions {
  signal?: AbortSignal;
}
