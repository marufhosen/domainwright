import type { SerializedError } from '../core/errors.js';
import type {
  CheckId,
  CheckResult,
  OutstandingAction,
  RequestOptions,
  RoutingStrategy,
  WorkerTarget,
} from '../core/types.js';
import type { HttpsExpectation } from './reachability.js';

/** How a hostname is expected to reach the Worker. */
export type RoutingSpec =
  | { strategy: 'custom-domain' }
  | { strategy: 'route' }
  | {
      strategy: 'saas-custom-hostname';
      /** Zone ID of the platform's Cloudflare for SaaS zone. */
      saasZoneId: string;
      /** Hostname tenants CNAME to, e.g. `customers.platform.com`. */
      cnameTarget: string;
    };

export interface VerifyDomainInput extends RequestOptions {
  /**
   * The domain being verified. For `custom-domain` and `route` strategies this is the
   * domain whose zone was onboarded (usually the apex); for SaaS custom hostnames it is
   * the tenant hostname.
   */
  domain: string;
  /** Hostnames that must serve traffic. Default: `[domain]`. */
  hostnames?: string[];
  /**
   * Cloudflare zone containing the hostnames when it differs from `domain`, e.g. the
   * platform zone `example.com` for a tenant subdomain `tenant-a.example.com`.
   */
  zone?: string;
  /** Tenant that must own the domain. Enables the tenant-bound ownership check. */
  tenantId?: string;
  /** Expected routing. When omitted, Workers Custom Domains and Routes are both detected. */
  routing?: RoutingSpec;
  /** Expected Worker. When omitted, any Worker satisfies the routing check. */
  worker?: WorkerTarget;
  /** HTTPS probe expectations, or `false` to skip the reachability check. */
  https?: HttpsExpectation | false;
  /** Restrict the checks that run. Default: all applicable checks. */
  checks?: CheckId[];
  /** Poll until verified, a permanent failure, or the timeout. Default false. */
  waitForReady?: boolean;
  /** Polling budget when `waitForReady` is set. Default 300 000 ms. */
  timeoutMs?: number;
  /** Initial polling interval. Default 15 000 ms. */
  intervalMs?: number;
}

export interface CheckError {
  check: CheckId;
  hostname?: string;
  status: 'failed' | 'error';
  message: string;
  error?: SerializedError;
}

export interface VerificationReport {
  domain: string;
  hostnames: string[];
  strategy: RoutingStrategy | 'auto';
  /** True only when every required check passed. */
  verified: boolean;
  /**
   * - `verified`: every required check passed.
   * - `pending`: nothing has failed permanently; waiting on propagation, issuance or an action.
   * - `failed`: at least one required check failed and needs a change.
   * - `error`: at least one check could not be completed; retry later.
   */
  summary: 'verified' | 'pending' | 'failed' | 'error';
  checks: CheckResult[];
  errors: CheckError[];
  outstandingActions: OutstandingAction[];
  checkedAt: string;
  attempts: number;
  /** True when `waitForReady` ran out of time. */
  timedOut: boolean;
}
