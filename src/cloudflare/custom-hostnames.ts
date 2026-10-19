import { ConfirmationRequiredError } from '../core/errors.js';
import type { RequestOptions } from '../core/types.js';
import { normalizeHostname } from '../utils/validation.js';
import type { CloudflareApi } from './api.js';
import { type CertificateReadiness, certificateReadiness } from './certificates.js';

export type CustomHostnameStatus =
  | 'active'
  | 'pending'
  | 'active_redeploying'
  | 'moved'
  | 'pending_deletion'
  | 'deleted'
  | 'pending_blocked'
  | 'pending_migration'
  | 'pending_provisioned'
  | 'test_pending'
  | 'test_active'
  | 'test_active_apex'
  | 'test_blocked'
  | 'test_failed'
  | 'provisioned'
  | 'blocked';

export interface ValidationRecord {
  txtName?: string;
  txtValue?: string;
  httpUrl?: string;
  httpBody?: string;
  cname?: string;
  cnameTarget?: string;
}

export interface CustomHostname {
  id: string;
  hostname: string;
  status: CustomHostnameStatus;
  ssl: {
    status: string | null;
    readiness: CertificateReadiness;
    method: 'http' | 'txt' | 'email' | null;
    validationRecords: ValidationRecord[];
    validationErrors: string[];
  };
  /** Pre-validation record that proves hostname ownership to Cloudflare. */
  ownershipVerification: { type: 'txt'; name: string; value: string } | null;
  ownershipVerificationHttp: { url: string; body: string } | null;
  verificationErrors: string[];
  customOriginServer: string | null;
}

export interface CreateCustomHostnameInput extends RequestOptions {
  /** The platform's SaaS zone that receives tenant traffic. */
  zoneId: string;
  hostname: string;
  /**
   * Certificate validation method. `http` (default) works once the tenant's CNAME points to
   * the platform; `txt` lets the tenant pre-validate before switching traffic.
   */
  sslMethod?: 'http' | 'txt';
  /** Origin hostname in the SaaS zone; defaults to the zone's fallback origin. */
  customOriginServer?: string;
}

interface RawValidationRecord {
  txt_name?: string;
  txt_value?: string;
  http_url?: string;
  http_body?: string;
  cname?: string;
  cname_target?: string;
}

interface RawCustomHostname {
  id: string;
  hostname: string;
  status?: CustomHostnameStatus;
  ssl?: {
    status?: string;
    method?: 'http' | 'txt' | 'email';
    validation_records?: RawValidationRecord[];
    validation_errors?: { message?: string }[];
  };
  ownership_verification?: { type?: 'txt'; name?: string; value?: string };
  ownership_verification_http?: { http_url?: string; http_body?: string };
  verification_errors?: string[];
  custom_origin_server?: string;
}

function mapValidationRecord(r: RawValidationRecord): ValidationRecord {
  const out: ValidationRecord = {};
  if (r.txt_name) out.txtName = r.txt_name;
  if (r.txt_value) out.txtValue = r.txt_value;
  if (r.http_url) out.httpUrl = r.http_url;
  if (r.http_body) out.httpBody = r.http_body;
  if (r.cname) out.cname = r.cname;
  if (r.cname_target) out.cnameTarget = r.cname_target;
  return out;
}

function mapCustomHostname(raw: RawCustomHostname): CustomHostname {
  const ov = raw.ownership_verification;
  const ovh = raw.ownership_verification_http;
  return {
    id: raw.id,
    hostname: raw.hostname,
    status: raw.status ?? 'pending',
    ssl: {
      status: raw.ssl?.status ?? null,
      readiness: certificateReadiness(raw.ssl?.status),
      method: raw.ssl?.method ?? null,
      validationRecords: (raw.ssl?.validation_records ?? []).map(mapValidationRecord),
      validationErrors: (raw.ssl?.validation_errors ?? []).map((e) => e.message ?? 'validation error'),
    },
    ownershipVerification: ov?.name && ov.value ? { type: 'txt', name: ov.name, value: ov.value } : null,
    ownershipVerificationHttp: ovh?.http_url && ovh.http_body ? { url: ovh.http_url, body: ovh.http_body } : null,
    verificationErrors: raw.verification_errors ?? [],
    customOriginServer: raw.custom_origin_server ?? null,
  };
}

/**
 * Cloudflare for SaaS custom hostnames (requires Cloudflare for SaaS on the platform zone).
 * Required token permission: `Zone > SSL and Certificates > Edit`.
 */
export class CustomHostnamesModule {
  constructor(private readonly api: CloudflareApi) {}

  async find(zoneId: string, hostname: string, options: RequestOptions = {}): Promise<CustomHostname | null> {
    const name = normalizeHostname(hostname, { field: 'hostname' });
    const raw = await this.api.list<RawCustomHostname>({
      path: `/zones/${encodeURIComponent(zoneId)}/custom_hostnames`,
      query: { 'hostname.exact': name },
      operation: 'customHostnames.list',
      perPage: 5,
      maxPages: 1,
      signal: options.signal,
    });
    const match = raw.find((h) => h.hostname === name);
    return match ? mapCustomHostname(match) : null;
  }

  async get(zoneId: string, customHostnameId: string, options: RequestOptions = {}): Promise<CustomHostname> {
    const raw = await this.api.request<RawCustomHostname>({
      method: 'GET',
      path: `/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(customHostnameId)}`,
      operation: 'customHostnames.get',
      signal: options.signal,
    });
    return mapCustomHostname(raw);
  }

  /** Create a custom hostname, or return the existing one for the same hostname. */
  async create(input: CreateCustomHostnameInput): Promise<CustomHostname & { created: boolean }> {
    const hostname = normalizeHostname(input.hostname, { field: 'hostname' });
    const existing = await this.find(input.zoneId, hostname, input);
    if (existing) return { ...existing, created: false };
    const raw = await this.api.request<RawCustomHostname>({
      method: 'POST',
      path: `/zones/${encodeURIComponent(input.zoneId)}/custom_hostnames`,
      body: {
        hostname,
        ssl: { method: input.sslMethod ?? 'http', type: 'dv' },
        ...(input.customOriginServer
          ? { custom_origin_server: normalizeHostname(input.customOriginServer, { field: 'customOriginServer' }) }
          : {}),
      },
      operation: 'customHostnames.create',
      signal: input.signal,
    });
    return { ...mapCustomHostname(raw), created: true };
  }

  async delete(input: { zoneId: string; customHostnameId: string; confirm: boolean } & RequestOptions): Promise<void> {
    if (!input.confirm) {
      throw new ConfirmationRequiredError('Deleting a custom hostname stops serving it; pass confirm: true', {
        customHostnameId: input.customHostnameId,
      });
    }
    await this.api.request({
      method: 'DELETE',
      path: `/zones/${encodeURIComponent(input.zoneId)}/custom_hostnames/${encodeURIComponent(input.customHostnameId)}`,
      operation: 'customHostnames.delete',
      signal: input.signal,
    });
  }
}
