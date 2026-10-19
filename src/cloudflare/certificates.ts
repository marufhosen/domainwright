import type { RequestOptions } from '../core/types.js';
import type { CloudflareApi } from './api.js';

/** Raw certificate status values used by Cloudflare certificate packs and custom hostnames. */
export type CloudflareCertificateStatus =
  | 'initializing'
  | 'pending_validation'
  | 'deleted'
  | 'pending_issuance'
  | 'pending_deployment'
  | 'pending_deletion'
  | 'pending_expiration'
  | 'expired'
  | 'active'
  | 'initializing_timed_out'
  | 'validation_timed_out'
  | 'issuance_timed_out'
  | 'deployment_timed_out'
  | 'deletion_timed_out'
  | 'pending_cleanup'
  | 'staging_deployment'
  | 'staging_active'
  | 'deactivating'
  | 'inactive'
  | 'backup_issued'
  | 'holding_deployment';

/** DomainPilot's reduction of Cloudflare certificate states. */
export type CertificateReadiness = 'active' | 'pending' | 'failed' | 'missing';

const FAILED = new Set<string>([
  'deleted',
  'expired',
  'initializing_timed_out',
  'validation_timed_out',
  'issuance_timed_out',
  'deployment_timed_out',
  'deletion_timed_out',
  'pending_deletion',
  'deactivating',
  'inactive',
]);

export function certificateReadiness(status: string | undefined | null): CertificateReadiness {
  if (!status) return 'missing';
  if (status === 'active') return 'active';
  if (FAILED.has(status)) return 'failed';
  return 'pending';
}

export interface CertificatePack {
  id: string;
  type: string;
  hosts: string[];
  status: CloudflareCertificateStatus;
  validationErrors: string[];
}

export interface HostnameCertificateStatus {
  hostname: string;
  readiness: CertificateReadiness;
  /** Raw Cloudflare status of the best matching pack. */
  status: string | null;
  packId: string | null;
  validationErrors: string[];
}

interface RawPack {
  id: string;
  type: string;
  hosts?: string[];
  status: CloudflareCertificateStatus;
  validation_errors?: { message?: string }[];
}

/** True when a certificate host entry (possibly a wildcard) covers `hostname`. */
export function certificateCovers(host: string, hostname: string): boolean {
  if (host === hostname) return true;
  if (host.startsWith('*.')) {
    const base = host.slice(2);
    const rest = hostname.slice(0, -(base.length + 1));
    return hostname.endsWith(`.${base}`) && rest.length > 0 && !rest.includes('.');
  }
  return false;
}

/**
 * Edge certificate status for zones in the account (Universal SSL, Advanced, and the
 * certificates Cloudflare issues for Workers Custom Domains).
 * Required token permission: `Zone > SSL and Certificates > Read`.
 */
export class CertificatesModule {
  constructor(private readonly api: CloudflareApi) {}

  async list(zoneId: string, options: RequestOptions = {}): Promise<CertificatePack[]> {
    const raw = await this.api.list<RawPack>({
      path: `/zones/${encodeURIComponent(zoneId)}/ssl/certificate_packs`,
      query: { status: 'all' },
      operation: 'certificates.list',
      perPage: 50,
      signal: options.signal,
    });
    return raw.map((p) => ({
      id: p.id,
      type: p.type,
      hosts: p.hosts ?? [],
      status: p.status,
      validationErrors: (p.validation_errors ?? []).map((e) => e.message ?? 'validation error'),
    }));
  }

  /** The most advanced certificate covering `hostname` (active > pending > failed). */
  async statusFor(zoneId: string, hostname: string, options: RequestOptions = {}): Promise<HostnameCertificateStatus> {
    const packs = (await this.list(zoneId, options)).filter((p) => p.hosts.some((h) => certificateCovers(h, hostname)));
    const rank: Record<CertificateReadiness, number> = { active: 0, pending: 1, failed: 2, missing: 3 };
    packs.sort((a, b) => rank[certificateReadiness(a.status)] - rank[certificateReadiness(b.status)]);
    const best = packs[0];
    if (!best) return { hostname, readiness: 'missing', status: null, packId: null, validationErrors: [] };
    return {
      hostname,
      readiness: certificateReadiness(best.status),
      status: best.status,
      packId: best.id,
      validationErrors: best.validationErrors,
    };
  }
}
