import { ConfirmationRequiredError, TenantConflictError, ValidationError } from '../core/errors.js';
import type { RequestOptions } from '../core/types.js';
import { assertNonEmptyString, normalizeHostname } from '../utils/validation.js';
import type { CloudflareApi } from './api.js';

export interface WorkerCustomDomain {
  id: string;
  hostname: string;
  service: string;
  zoneId: string;
  zoneName: string;
  /** Certificate Cloudflare issued for this custom domain, when known. */
  certId: string | null;
}

export interface AttachCustomDomainInput extends RequestOptions {
  hostname: string;
  /** Worker (script) name that should receive the traffic. */
  service: string;
  zoneId?: string;
  zoneName?: string;
  /**
   * Allow moving a hostname that is currently attached to a *different* Worker.
   * Default false: such a request throws `TENANT_CONFLICT`, preventing cross-tenant
   * or cross-application takeover.
   */
  allowReassign?: boolean;
}

export interface WorkerRoute {
  id: string;
  zoneId: string;
  pattern: string;
  /** Worker the route invokes; absent for routes that disable Workers on a path. */
  script: string | null;
}

export interface CreateRouteInput extends RequestOptions {
  zoneId: string;
  /** Route pattern such as `example.com/*` or `*.example.com/*`. */
  pattern: string;
  script: string;
  /** Allow re-pointing an existing route for the same pattern at a different Worker. Default false. */
  allowReassign?: boolean;
}

interface RawCustomDomain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
  cert_id?: string | null;
}

interface RawRoute {
  id: string;
  pattern: string;
  script?: string | null;
}

function mapDomain(raw: RawCustomDomain): WorkerCustomDomain {
  return {
    id: raw.id,
    hostname: raw.hostname,
    service: raw.service,
    zoneId: raw.zone_id,
    zoneName: raw.zone_name,
    certId: raw.cert_id ?? null,
  };
}

/**
 * Workers Custom Domains. Cloudflare creates and manages the DNS record and the
 * certificate for each attached hostname. The zone must belong to the configured
 * account. Required token permission: `Account > Workers Scripts > Edit`.
 */
export class WorkerCustomDomainsModule {
  constructor(private readonly api: CloudflareApi) {}

  async list(
    filter: { hostname?: string; service?: string; zoneId?: string; zoneName?: string } & RequestOptions = {},
  ): Promise<WorkerCustomDomain[]> {
    const raw = await this.api.request<RawCustomDomain[]>({
      method: 'GET',
      path: `/accounts/${this.api.accountId}/workers/domains`,
      query: {
        hostname: filter.hostname === undefined ? undefined : normalizeHostname(filter.hostname, { field: 'hostname' }),
        service: filter.service,
        zone_id: filter.zoneId,
        zone_name: filter.zoneName,
      },
      operation: 'workers.domains.list',
      signal: filter.signal,
    });
    return (raw ?? []).map(mapDomain);
  }

  async findByHostname(hostname: string, options: RequestOptions = {}): Promise<WorkerCustomDomain | null> {
    const name = normalizeHostname(hostname, { field: 'hostname' });
    const domains = await this.list({ hostname: name, signal: options.signal });
    return domains.find((d) => d.hostname === name) ?? null;
  }

  async get(domainId: string, options: RequestOptions = {}): Promise<WorkerCustomDomain> {
    const raw = await this.api.request<RawCustomDomain>({
      method: 'GET',
      path: `/accounts/${this.api.accountId}/workers/domains/${encodeURIComponent(domainId)}`,
      operation: 'workers.domains.get',
      signal: options.signal,
    });
    return mapDomain(raw);
  }

  /**
   * Attach a hostname to a Worker. Idempotent: when the hostname is already attached to
   * the same Worker the existing attachment is returned with `created: false`.
   */
  async attach(input: AttachCustomDomainInput): Promise<WorkerCustomDomain & { created: boolean }> {
    const hostname = normalizeHostname(input.hostname, { field: 'hostname' });
    assertNonEmptyString(input.service, 'service');
    if (!input.zoneId && !input.zoneName) {
      throw new ValidationError('zoneId or zoneName is required to attach a custom domain', { field: 'zoneId' });
    }
    const existing = await this.findByHostname(hostname, input);
    if (existing && existing.service === input.service) return { ...existing, created: false };
    if (existing && !input.allowReassign) {
      throw new TenantConflictError(
        `${hostname} is already attached to a different Worker; pass allowReassign: true only after confirming the move is authorized`,
        { hostname, currentService: existing.service, requestedService: input.service },
      );
    }
    const raw = await this.api.request<RawCustomDomain>({
      method: 'PUT',
      path: `/accounts/${this.api.accountId}/workers/domains`,
      body: {
        hostname,
        service: input.service,
        ...(input.zoneId ? { zone_id: input.zoneId } : {}),
        ...(input.zoneName ? { zone_name: input.zoneName } : {}),
      },
      operation: 'workers.domains.attach',
      signal: input.signal,
    });
    return { ...mapDomain(raw), created: true };
  }

  /** Detach a custom domain. Destructive: requires `confirm: true`. */
  async detach(input: { domainId: string; confirm: boolean } & RequestOptions): Promise<void> {
    if (!input.confirm) {
      throw new ConfirmationRequiredError('Detaching a custom domain stops traffic to the Worker; pass confirm: true', {
        domainId: input.domainId,
      });
    }
    await this.api.request({
      method: 'DELETE',
      path: `/accounts/${this.api.accountId}/workers/domains/${encodeURIComponent(input.domainId)}`,
      operation: 'workers.domains.detach',
      signal: input.signal,
    });
  }
}

/**
 * Workers Routes. A route only runs when the hostname has a proxied DNS record, so the
 * onboarding workflow creates one (an originless `AAAA 100::` record) when missing.
 * Required token permission: `Zone > Workers Routes > Edit`.
 */
export class WorkerRoutesModule {
  constructor(private readonly api: CloudflareApi) {}

  async list(zoneId: string, options: RequestOptions = {}): Promise<WorkerRoute[]> {
    const raw = await this.api.request<RawRoute[]>({
      method: 'GET',
      path: `/zones/${encodeURIComponent(zoneId)}/workers/routes`,
      operation: 'workers.routes.list',
      signal: options.signal,
    });
    return (raw ?? []).map((r) => ({ id: r.id, zoneId, pattern: r.pattern, script: r.script ?? null }));
  }

  /** Create a route, reusing an identical route and refusing to re-point one silently. */
  async create(input: CreateRouteInput): Promise<WorkerRoute & { created: boolean }> {
    const pattern = validateRoutePattern(input.pattern);
    assertNonEmptyString(input.script, 'script');
    const routes = await this.list(input.zoneId, input);
    const existing = routes.find((r) => r.pattern === pattern);
    if (existing && existing.script === input.script) return { ...existing, created: false };
    if (existing) {
      if (!input.allowReassign) {
        throw new TenantConflictError(`Route ${pattern} already points to a different Worker`, {
          pattern,
          currentScript: existing.script,
          requestedScript: input.script,
        });
      }
      await this.api.request({
        method: 'PUT',
        path: `/zones/${encodeURIComponent(input.zoneId)}/workers/routes/${encodeURIComponent(existing.id)}`,
        body: { pattern, script: input.script },
        operation: 'workers.routes.update',
        signal: input.signal,
      });
      return { ...existing, script: input.script, created: false };
    }
    const raw = await this.api.request<RawRoute>({
      method: 'POST',
      path: `/zones/${encodeURIComponent(input.zoneId)}/workers/routes`,
      body: { pattern, script: input.script },
      operation: 'workers.routes.create',
      signal: input.signal,
    });
    return {
      id: raw.id,
      zoneId: input.zoneId,
      pattern: raw.pattern ?? pattern,
      script: raw.script ?? input.script,
      created: true,
    };
  }

  async delete(input: { zoneId: string; routeId: string; confirm: boolean } & RequestOptions): Promise<void> {
    if (!input.confirm) {
      throw new ConfirmationRequiredError('Deleting a Worker route stops traffic to the Worker; pass confirm: true', {
        routeId: input.routeId,
      });
    }
    await this.api.request({
      method: 'DELETE',
      path: `/zones/${encodeURIComponent(input.zoneId)}/workers/routes/${encodeURIComponent(input.routeId)}`,
      operation: 'workers.routes.delete',
      signal: input.signal,
    });
  }
}

/** Validate a Workers route pattern (`host/path` with optional leading `*` and trailing `*`). */
export function validateRoutePattern(pattern: string): string {
  const value = pattern.trim().toLowerCase();
  if (/^\*\/.*$/.test(value)) return value; // catch-all host, e.g. `*/*` on a SaaS zone
  const match = /^(?:https?:\/\/)?(\*\.?)?([^/*]+)(\/.*)?$/.exec(value);
  if (!match || !match[2]) throw new ValidationError(`Invalid route pattern "${pattern}"`, { field: 'pattern' });
  normalizeHostname(match[2], { field: 'pattern' });
  if (!match[3])
    throw new ValidationError('Route patterns must include a path, e.g. example.com/*', { field: 'pattern' });
  return value;
}

/** Does a route pattern match requests to `hostname`? Only host matching is evaluated. */
export function routeMatchesHostname(pattern: string, hostname: string): boolean {
  const host = pattern.replace(/^https?:\/\//, '').split('/')[0] ?? '';
  if (host === '*') return true;
  if (host.startsWith('*.')) return hostname.endsWith(host.slice(1));
  // `*example.com` matches example.com and every name ending in it.
  if (host.startsWith('*')) return hostname.endsWith(host.slice(1));
  return host === hostname;
}
