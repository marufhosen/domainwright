import { ConfirmationRequiredError, DomainwrightError, ValidationError } from '../core/errors.js';
import type { RequestOptions } from '../core/types.js';
import { isIPv4, isIPv6, normalizeHostname, resolveRecordName } from '../utils/validation.js';
import type { CloudflareApi } from './api.js';
import type { ZonesModule } from './zones.js';

export type DnsRecordType =
  | 'A'
  | 'AAAA'
  | 'CNAME'
  | 'TXT'
  | 'MX'
  | 'NS'
  | 'CAA'
  | 'SRV'
  | 'HTTPS'
  | 'SVCB'
  | 'PTR'
  | 'CERT'
  | 'DNSKEY'
  | 'DS'
  | 'LOC'
  | 'NAPTR'
  | 'SMIMEA'
  | 'SSHFP'
  | 'TLSA'
  | 'URI';

/** Record types whose content is a single `content` string validated by Domainwright. */
const CONTENT_TYPES = new Set<DnsRecordType>(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'PTR', 'CAA', 'HTTPS', 'SVCB']);
const PROXIABLE = new Set<DnsRecordType>(['A', 'AAAA', 'CNAME']);

export interface DnsRecord {
  id: string;
  zoneId: string;
  name: string;
  type: DnsRecordType;
  content: string;
  /** 1 means "automatic". */
  ttl: number;
  proxied: boolean;
  proxiable: boolean;
  priority?: number;
  comment: string | null;
  /** True when the record carries the Domainwright management marker. */
  managed: boolean;
  /** Tenant tag from the management marker, when present. */
  tenantTag: string | null;
  data?: Record<string, unknown>;
}

/** Target a zone either by ID or by its apex domain. */
export type ZoneRef = { zoneId: string; domain?: never } | { domain: string; zoneId?: never };

export interface DnsRecordInput {
  type: DnsRecordType;
  /** `@`, a relative name such as `www`, or a fully qualified name inside the zone. */
  name: string;
  /** Record content (address, target hostname, text, ...). Use `data` for structured types. */
  content?: string;
  /** Structured data for SRV, CAA, CERT, ... records, passed to Cloudflare unchanged. */
  data?: Record<string, unknown>;
  /** Seconds, or 1 for automatic. Default 1. */
  ttl?: number;
  /** Proxy through Cloudflare (A, AAAA and CNAME only). Default false. */
  proxied?: boolean;
  /** Required for MX and URI records. */
  priority?: number;
  /** Free-form note stored on the record. The Domainwright marker is appended automatically. */
  comment?: string;
}

export type CreateDnsRecordInput = ZoneRef &
  DnsRecordInput &
  RequestOptions & {
    /**
     * Tag the record as managed by Domainwright (default true). Managed records can be
     * updated or removed by Domainwright later; unmanaged records are never touched
     * without `allowUnmanaged`.
     */
    managed?: boolean;
    /** Opaque tenant tag stored in the marker (see `OwnershipModule.tenantTag`). */
    tenantTag?: string;
    /**
     * What to do when the same record (type, name, content) already exists.
     * `reuse` (default) returns the existing record; `error` throws `CONFLICT`.
     */
    onDuplicate?: 'reuse' | 'error';
  };

export interface CreateDnsRecordResult extends DnsRecord {
  created: boolean;
}

export type ListDnsRecordsInput = ZoneRef & RequestOptions & { type?: DnsRecordType; name?: string };

export type UpdateDnsRecordInput = ZoneRef &
  RequestOptions & {
    recordId: string;
    changes: Partial<Omit<DnsRecordInput, 'type'>>;
    /** Allow changing a record that Domainwright did not create. Default false. */
    allowUnmanaged?: boolean;
  };

export type DeleteDnsRecordInput = ZoneRef &
  RequestOptions & {
    recordId: string;
    /** Required: deletion is destructive. */
    confirm: boolean;
    /** Allow deleting a record that Domainwright did not create. Default false. */
    allowUnmanaged?: boolean;
  };

interface RawRecord {
  id: string;
  zone_id?: string;
  name: string;
  type: DnsRecordType;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  proxiable?: boolean;
  priority?: number;
  comment?: string | null;
  data?: Record<string, unknown>;
}

const MARKER_RE = /\[domainwright(?: t=([A-Za-z0-9_-]{1,32}))?\]/;

export function buildMarker(tenantTag?: string): string {
  return tenantTag ? `[domainwright t=${tenantTag}]` : '[domainwright]';
}

export function parseMarker(comment: string | null | undefined): { managed: boolean; tenantTag: string | null } {
  const match = comment ? MARKER_RE.exec(comment) : null;
  return { managed: Boolean(match), tenantTag: match?.[1] ?? null };
}

function mapRecord(raw: RawRecord, zoneId: string): DnsRecord {
  const marker = parseMarker(raw.comment);
  return {
    id: raw.id,
    zoneId: raw.zone_id ?? zoneId,
    name: raw.name,
    type: raw.type,
    content: raw.content ?? '',
    ttl: raw.ttl ?? 1,
    proxied: raw.proxied ?? false,
    proxiable: raw.proxiable ?? PROXIABLE.has(raw.type),
    ...(raw.priority === undefined ? {} : { priority: raw.priority }),
    comment: raw.comment ?? null,
    managed: marker.managed,
    tenantTag: marker.tenantTag,
    ...(raw.data === undefined ? {} : { data: raw.data }),
  };
}

/** Normalize content for comparison (case-insensitive hostnames, trailing dots, quotes). */
function comparableContent(type: DnsRecordType, content: string): string {
  if (type === 'TXT') return content.replace(/^"|"$/g, '');
  if (type === 'AAAA') {
    try {
      return new URL(`http://[${content}]/`).hostname;
    } catch {
      return content.toLowerCase();
    }
  }
  return content.toLowerCase().replace(/\.$/, '');
}

export function sameRecord(
  a: { type: DnsRecordType; name: string; content: string },
  b: { type: DnsRecordType; name: string; content: string },
): boolean {
  return (
    a.type === b.type &&
    a.name === b.name &&
    comparableContent(a.type, a.content) === comparableContent(b.type, b.content)
  );
}

/**
 * Validate a record before sending it. Throws `ValidationError` describing the first problem.
 */
export function validateRecord(input: DnsRecordInput, zoneName: string): { name: string; content?: string } {
  const name = resolveRecordName(input.name, zoneName);
  if (
    input.ttl !== undefined &&
    input.ttl !== 1 &&
    (!Number.isInteger(input.ttl) || input.ttl < 30 || input.ttl > 86_400)
  ) {
    throw new ValidationError('ttl must be 1 (automatic) or between 30 and 86400 seconds', { field: 'ttl' });
  }
  if (input.proxied && !PROXIABLE.has(input.type)) {
    throw new ValidationError(`${input.type} records cannot be proxied`, { field: 'proxied' });
  }
  if (input.type === 'MX' || input.type === 'URI') {
    if (
      input.priority === undefined ||
      !Number.isInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > 65_535
    ) {
      throw new ValidationError(`${input.type} records require a priority between 0 and 65535`, { field: 'priority' });
    }
  }
  if (!CONTENT_TYPES.has(input.type)) {
    if (!input.data && input.content === undefined) {
      throw new ValidationError(`${input.type} records require content or data`, { field: 'data' });
    }
    return { name, ...(input.content === undefined ? {} : { content: input.content }) };
  }

  const content = input.content?.trim();
  if (!content) throw new ValidationError(`${input.type} records require content`, { field: 'content' });
  switch (input.type) {
    case 'A':
      if (!isIPv4(content)) throw new ValidationError('A record content must be an IPv4 address', { field: 'content' });
      break;
    case 'AAAA':
      if (!isIPv6(content))
        throw new ValidationError('AAAA record content must be an IPv6 address', { field: 'content' });
      break;
    case 'CNAME': {
      const target = normalizeHostname(content, { field: 'content', allowUnderscore: true });
      if (target === name) throw new ValidationError('A CNAME record cannot point to itself', { field: 'content' });
      return { name, content: target };
    }
    case 'MX':
    case 'NS':
    case 'PTR':
      return { name, content: normalizeHostname(content, { field: 'content', allowUnderscore: true }) };
    case 'TXT':
      if (content.length > 2048) throw new ValidationError('TXT content exceeds 2048 characters', { field: 'content' });
      break;
    case 'CAA':
      if (!/^\d{1,3} (issue|issuewild|iodef) "[^"]*"$/.test(content)) {
        throw new ValidationError('CAA content must look like: 0 issue "letsencrypt.org"', { field: 'content' });
      }
      break;
    default:
      break;
  }
  return { name, content };
}

/**
 * DNS record management for zones in the configured Cloudflare account.
 * Required token permissions: `Zone > DNS > Read` (list/get) and `Zone > DNS > Edit` (create/update/delete).
 */
export class DnsModule {
  constructor(
    private readonly api: CloudflareApi,
    private readonly zones: ZonesModule,
  ) {}

  async list(input: ListDnsRecordsInput): Promise<DnsRecord[]> {
    const zone = await this.zoneOf(input);
    const name = input.name === undefined ? undefined : resolveRecordName(input.name, zone.name);
    const raw = await this.api.list<RawRecord>({
      path: `/zones/${zone.id}/dns_records`,
      query: { type: input.type, 'name.exact': name },
      operation: 'dns.list',
      perPage: 100,
      signal: input.signal,
    });
    return raw.map((r) => mapRecord(r, zone.id));
  }

  async get(input: ZoneRef & RequestOptions & { recordId: string }): Promise<DnsRecord> {
    const zone = await this.zoneOf(input);
    const raw = await this.api.request<RawRecord>({
      method: 'GET',
      path: `/zones/${zone.id}/dns_records/${encodeURIComponent(input.recordId)}`,
      operation: 'dns.get',
      signal: input.signal,
    });
    return mapRecord(raw, zone.id);
  }

  /**
   * Create a record after validating it and checking for duplicates and conflicts:
   * - an identical record is reused (or rejected with `onDuplicate: 'error'`);
   * - a CNAME cannot coexist with any other record at the same name, and an A/AAAA/CNAME
   *   cannot be added where a CNAME exists. Conflicts throw `CONFLICT` listing the records.
   * Existing records are never modified or deleted by this method.
   */
  async create(input: CreateDnsRecordInput): Promise<CreateDnsRecordResult> {
    const zone = await this.zoneOf(input);
    const { name, content } = validateRecord(input, zone.name);
    const existing = await this.list({ zoneId: zone.id, name, signal: input.signal });

    const duplicate =
      content === undefined ? undefined : existing.find((r) => sameRecord(r, { type: input.type, name, content }));
    if (duplicate) {
      if (input.onDuplicate === 'error') {
        throw new DomainwrightError('CONFLICT', `An identical ${input.type} record already exists for ${name}`, {
          details: { recordId: duplicate.id },
        });
      }
      return { ...duplicate, created: false };
    }

    // A CNAME cannot coexist with any other record at the same name (RFC 1034 section 3.6.2).
    const conflicts = input.type === 'CNAME' ? existing : existing.filter((r) => r.type === 'CNAME');
    if (conflicts.length > 0) {
      throw new DomainwrightError('CONFLICT', `Conflicting DNS records exist for ${name}`, {
        details: {
          name,
          conflicts: conflicts.map((r) => ({ id: r.id, type: r.type, content: r.content, managed: r.managed })),
        },
      });
    }

    const managed = input.managed ?? true;
    const comment = [input.comment?.trim(), managed ? buildMarker(input.tenantTag) : undefined]
      .filter(Boolean)
      .join(' ');
    const raw = await this.api.request<RawRecord>({
      method: 'POST',
      path: `/zones/${zone.id}/dns_records`,
      body: {
        type: input.type,
        name,
        ...(content === undefined ? {} : { content }),
        ...(input.data === undefined ? {} : { data: input.data }),
        ttl: input.ttl ?? 1,
        ...(PROXIABLE.has(input.type) ? { proxied: input.proxied ?? false } : {}),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(comment ? { comment } : {}),
      },
      operation: 'dns.create',
      signal: input.signal,
    });
    return { ...mapRecord(raw, zone.id), created: true };
  }

  async update(input: UpdateDnsRecordInput): Promise<DnsRecord> {
    const zone = await this.zoneOf(input);
    const current = await this.get({ zoneId: zone.id, recordId: input.recordId, signal: input.signal });
    if (!current.managed && !input.allowUnmanaged) {
      throw new ConfirmationRequiredError(
        `Record ${current.name} (${current.type}) was not created by Domainwright; pass allowUnmanaged: true to modify it`,
        { recordId: current.id },
      );
    }
    const priority = input.changes.priority ?? current.priority;
    const data = input.changes.data ?? current.data;
    const merged: DnsRecordInput = {
      type: current.type,
      name: input.changes.name ?? current.name,
      content: input.changes.content ?? current.content,
      ttl: input.changes.ttl ?? current.ttl,
      proxied: input.changes.proxied ?? current.proxied,
      ...(priority === undefined ? {} : { priority }),
      ...(data === undefined ? {} : { data }),
    };
    const { name, content } = validateRecord(merged, zone.name);
    const marker = current.managed ? buildMarker(current.tenantTag ?? undefined) : '';
    const userComment = input.changes.comment ?? current.comment?.replace(MARKER_RE, '').trim();
    const comment = [userComment, marker].filter(Boolean).join(' ');
    const raw = await this.api.request<RawRecord>({
      method: 'PATCH',
      path: `/zones/${zone.id}/dns_records/${encodeURIComponent(input.recordId)}`,
      body: {
        name,
        ...(content === undefined ? {} : { content }),
        ...(merged.data === undefined ? {} : { data: merged.data }),
        ttl: merged.ttl,
        ...(PROXIABLE.has(current.type) ? { proxied: merged.proxied } : {}),
        ...(merged.priority === undefined ? {} : { priority: merged.priority }),
        comment,
      },
      idempotent: true,
      operation: 'dns.update',
      signal: input.signal,
    });
    return mapRecord(raw, zone.id);
  }

  async delete(input: DeleteDnsRecordInput): Promise<void> {
    if (!input.confirm) {
      throw new ConfirmationRequiredError('Deleting a DNS record is destructive; pass confirm: true', {
        recordId: input.recordId,
      });
    }
    const zone = await this.zoneOf(input);
    const current = await this.get({ zoneId: zone.id, recordId: input.recordId, signal: input.signal });
    if (!current.managed && !input.allowUnmanaged) {
      throw new ConfirmationRequiredError(
        `Record ${current.name} (${current.type}) was not created by Domainwright; pass allowUnmanaged: true to delete it`,
        { recordId: current.id },
      );
    }
    await this.api.request({
      method: 'DELETE',
      path: `/zones/${zone.id}/dns_records/${encodeURIComponent(input.recordId)}`,
      operation: 'dns.delete',
      signal: input.signal,
    });
  }

  private async zoneOf(ref: ZoneRef & RequestOptions): Promise<{ id: string; name: string }> {
    if (ref.zoneId) {
      const zone = await this.zones.get(ref.zoneId, ref);
      return { id: zone.id, name: zone.name };
    }
    if (!ref.domain) throw new ValidationError('Either zoneId or domain is required', { field: 'zoneId' });
    const zone = await this.zones.resolve(normalizeHostname(ref.domain), ref);
    return { id: zone.id, name: zone.name };
  }
}
