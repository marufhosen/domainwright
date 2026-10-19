import type { CloudflareConfig } from '../cloudflare/client.js';
import type { OwnershipConfig } from '../ownership/ownership.js';
import type { NameComConfig } from '../registrars/namecom/adapter.js';
import type { RegistrarAdapter } from '../registrars/types.js';
import type { DnsResolver } from '../verification/resolver.js';
import { ConfigurationError } from './errors.js';
import type { FetchLike, HttpOptions } from './http.js';
import type { Logger } from './logger.js';

/**
 * Client configuration. Every credential is supplied by the consuming application; the
 * SDK stores them only in memory and never logs or returns them. Create one client per
 * credential set (e.g. one for development, one for production).
 */
export interface DomainPilotConfig {
  /** Required for zone, DNS, Worker, verification and workflow operations. */
  cloudflare?: CloudflareConfig;
  /**
   * Required for search and registration. Pass a built-in provider configuration or any
   * object implementing `RegistrarAdapter`.
   */
  registrar?: NameComConfig | RegistrarAdapter;
  /** Required for tenant-bound ownership markers and challenges (`tenantId` options). */
  ownership?: OwnershipConfig;
  /** HTTP transport options shared by every provider call. */
  http?: HttpOptions;
  /** Public DNS used by verification. Default: Cloudflare DNS-over-HTTPS. */
  dns?: { resolver?: DnsResolver; dohUrl?: string };
  /** fetch used for HTTPS reachability probes. Defaults to `http.fetch` or global fetch. */
  probeFetch?: FetchLike;
  /** Structured logger. Fields are redacted before they reach it. */
  logger?: Logger;
}

export function isRegistrarAdapter(value: unknown): value is RegistrarAdapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RegistrarAdapter).checkAvailability === 'function' &&
    typeof (value as RegistrarAdapter).capabilities === 'object'
  );
}

export function validateConfig(config: DomainPilotConfig): void {
  if (!config || typeof config !== 'object') throw new ConfigurationError('A configuration object is required');
  if (!config.cloudflare && !config.registrar) {
    throw new ConfigurationError('Configure at least one provider: cloudflare and/or registrar');
  }
  if (config.registrar && !isRegistrarAdapter(config.registrar)) {
    const provider = (config.registrar as { provider?: unknown }).provider;
    if (provider !== 'namecom') {
      throw new ConfigurationError(
        `Unsupported registrar provider "${String(provider)}". Supported: "namecom", or pass a RegistrarAdapter`,
        {
          field: 'registrar.provider',
        },
      );
    }
  }
}
