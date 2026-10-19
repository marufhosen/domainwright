import { ConfigurationError, isDomainwrightError } from '../core/errors.js';
import { HttpClient, type HttpOptions } from '../core/http.js';
import { type Logger, createSafeLogger } from '../core/logger.js';
import type { RequestOptions } from '../core/types.js';
import { CLOUDFLARE_API_BASE, CloudflareApi } from './api.js';
import { CertificatesModule } from './certificates.js';
import { CustomHostnamesModule } from './custom-hostnames.js';
import { DnsModule } from './dns.js';
import { WorkerCustomDomainsModule, WorkerRoutesModule } from './workers.js';
import { ZonesModule } from './zones.js';

export interface CloudflareConfig {
  /** API token created by the consuming application. Never logged or returned. */
  apiToken: string;
  /** Account that owns zones, Workers and custom domains. */
  accountId: string;
  /** Override the API base URL (testing only). */
  baseUrl?: string;
}

export interface CloudflareClientOptions {
  http?: HttpOptions | HttpClient;
  logger?: Logger;
}

export type AccessCheck = 'token' | 'zones:read' | 'workers-domains:read';

export interface AccessReport {
  tokenActive: boolean;
  checks: { check: AccessCheck; ok: boolean; code?: string; message?: string }[];
}

export function validateCloudflareConfig(config: CloudflareConfig): void {
  if (!config || typeof config !== 'object') throw new ConfigurationError('cloudflare configuration is required');
  if (typeof config.apiToken !== 'string' || config.apiToken.trim().length < 20) {
    throw new ConfigurationError('cloudflare.apiToken must be a Cloudflare API token', {
      field: 'cloudflare.apiToken',
    });
  }
  if (typeof config.accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(config.accountId)) {
    throw new ConfigurationError('cloudflare.accountId must be a 32-character Cloudflare account ID', {
      field: 'cloudflare.accountId',
    });
  }
}

/**
 * Standalone Cloudflare client. Usable on its own (`import { CloudflareClient } from
 * '<package>/cloudflare'`) or through `Domainwright#cloudflare`.
 * Construction performs no network calls.
 */
export class CloudflareClient {
  readonly zones: ZonesModule;
  readonly dns: DnsModule;
  readonly workers: { customDomains: WorkerCustomDomainsModule; routes: WorkerRoutesModule };
  readonly customHostnames: CustomHostnamesModule;
  readonly certificates: CertificatesModule;
  readonly accountId: string;
  /** @internal */
  readonly api: CloudflareApi;

  constructor(config: CloudflareConfig, options: CloudflareClientOptions = {}) {
    validateCloudflareConfig(config);
    const logger = createSafeLogger(options.logger);
    const http = options.http instanceof HttpClient ? options.http : new HttpClient(options.http, logger);
    this.accountId = config.accountId;
    this.api = new CloudflareApi(http, config.apiToken.trim(), config.accountId, config.baseUrl ?? CLOUDFLARE_API_BASE);
    this.zones = new ZonesModule(this.api);
    this.dns = new DnsModule(this.api, this.zones);
    this.workers = {
      customDomains: new WorkerCustomDomainsModule(this.api),
      routes: new WorkerRoutesModule(this.api),
    };
    this.customHostnames = new CustomHostnamesModule(this.api);
    this.certificates = new CertificatesModule(this.api);
  }

  /**
   * Verify that the token is valid and active. Supports user-owned tokens
   * (`/user/tokens/verify`) and account-owned tokens (`/accounts/{id}/tokens/verify`).
   */
  async verifyToken(options: RequestOptions = {}): Promise<{ active: boolean; status: string }> {
    const attempt = async (path: string): Promise<{ status?: string }> =>
      this.api.request<{ status?: string }>({
        method: 'GET',
        path,
        operation: 'tokens.verify',
        signal: options.signal,
      });
    let result: { status?: string };
    try {
      result = await attempt('/user/tokens/verify');
    } catch (error) {
      if (
        !isDomainwrightError(error) ||
        !['AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND'].includes(error.code)
      ) {
        throw error;
      }
      result = await attempt(`/accounts/${this.accountId}/tokens/verify`);
    }
    const status = result.status ?? 'unknown';
    return { active: status === 'active', status };
  }

  /**
   * Probe read access for the modules Domainwright uses. Cloudflare does not expose a
   * token's permission list to the token itself, so write permissions are confirmed
   * only when an operation runs; this reports read access and token validity.
   */
  async checkAccess(options: RequestOptions = {}): Promise<AccessReport> {
    const checks: AccessReport['checks'] = [];
    const probe = async (check: AccessCheck, fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        checks.push({ check, ok: true });
        return true;
      } catch (error) {
        if (!isDomainwrightError(error)) throw error;
        checks.push({ check, ok: false, code: error.code, message: error.message });
        return false;
      }
    };
    let tokenActive = false;
    await probe('token', async () => {
      tokenActive = (await this.verifyToken(options)).active;
    });
    await probe('zones:read', () =>
      this.api.request({
        method: 'GET',
        path: '/zones',
        query: { 'account.id': this.accountId, per_page: 5 },
        operation: 'zones.list',
        signal: options.signal,
      }),
    );
    await probe('workers-domains:read', () => this.workers.customDomains.list(options));
    return { tokenActive, checks };
  }
}
