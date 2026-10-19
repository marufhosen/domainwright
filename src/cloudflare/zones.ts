import { ConfirmationRequiredError, ProviderError, isDomainPilotError } from '../core/errors.js';
import type { RequestOptions } from '../core/types.js';
import { type PollOptions, poll } from '../utils/polling.js';
import { normalizeHostname } from '../utils/validation.js';
import type { CloudflareApi } from './api.js';

/** Zone status as returned by Cloudflare. */
export type ZoneStatus = 'initializing' | 'pending' | 'active' | 'moved';
export type ZoneType = 'full' | 'partial' | 'secondary' | 'internal';

export interface Zone {
  id: string;
  name: string;
  status: ZoneStatus;
  type: ZoneType;
  /** Authoritative nameservers Cloudflare assigned to this zone. */
  nameservers: string[];
  /** Nameservers the domain used before moving to Cloudflare, when Cloudflare detected them. */
  originalNameservers: string[];
  originalRegistrar: string | null;
  activatedOn: string | null;
  paused: boolean;
  accountId: string | null;
}

export interface NameserverInstructions {
  domain: string;
  /** Set exactly these nameservers at the domain's registrar. */
  nameservers: string[];
  /** Nameservers currently observed by Cloudflare (may be stale or empty). */
  currentNameservers: string[];
  instructions: string;
}

export interface CreateZoneInput extends RequestOptions {
  /** Apex domain of the zone, e.g. `example.com`. */
  domain: string;
  /** Zone type. Only `full` setups are supported by the onboarding workflow. Default `full`. */
  type?: Extract<ZoneType, 'full' | 'partial'>;
}

export interface CreateZoneResult extends Zone {
  /** False when an existing zone in the account was returned instead of creating a duplicate. */
  created: boolean;
  /** Present while the zone is not active: how to delegate the domain to Cloudflare. */
  nameserverInstructions?: NameserverInstructions;
}

interface RawZone {
  id: string;
  name: string;
  status: ZoneStatus;
  type?: ZoneType;
  name_servers?: string[];
  original_name_servers?: string[] | null;
  original_registrar?: string | null;
  activated_on?: string | null;
  paused?: boolean;
  account?: { id?: string };
}

function mapZone(raw: RawZone): Zone {
  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    type: raw.type ?? 'full',
    nameservers: raw.name_servers ?? [],
    originalNameservers: raw.original_name_servers ?? [],
    originalRegistrar: raw.original_registrar ?? null,
    activatedOn: raw.activated_on ?? null,
    paused: raw.paused ?? false,
    accountId: raw.account?.id ?? null,
  };
}

export function nameserverInstructions(zone: Zone): NameserverInstructions {
  return {
    domain: zone.name,
    nameservers: zone.nameservers,
    currentNameservers: zone.originalNameservers,
    instructions:
      `Sign in to the registrar for ${zone.name} and replace its nameservers with ` +
      `${zone.nameservers.join(' and ')}. Remove any other nameservers and disable DNSSEC at the ` +
      `registrar until the zone is active. Delegation usually completes within hours but can take up to 24 hours.`,
  };
}

/**
 * Cloudflare zone management. Required token permissions:
 * `Zone > Zone > Read` for lookups, `Zone > Zone > Edit` to create, delete or re-check zones.
 */
export class ZonesModule {
  constructor(private readonly api: CloudflareApi) {}

  /** Find a zone by exact name within the configured account. Returns `null` when absent. */
  async find(domain: string, options: RequestOptions = {}): Promise<Zone | null> {
    const name = normalizeHostname(domain);
    const zones = await this.api.list<RawZone>({
      path: '/zones',
      query: { name, 'account.id': this.api.accountId },
      operation: 'zones.list',
      perPage: 5,
      maxPages: 1,
      signal: options.signal,
    });
    const match = zones.find((z) => z.name === name);
    return match ? mapZone(match) : null;
  }

  async get(zoneId: string, options: RequestOptions = {}): Promise<Zone> {
    const raw = await this.api.request<RawZone>({
      method: 'GET',
      path: `/zones/${encodeURIComponent(zoneId)}`,
      operation: 'zones.get',
      signal: options.signal,
    });
    return mapZone(raw);
  }

  /**
   * Find the zone that contains `hostname` by testing the hostname and each parent
   * (e.g. `a.b.example.com`, `b.example.com`, `example.com`).
   */
  async findForHostname(hostname: string, options: RequestOptions = {}): Promise<Zone | null> {
    const labels = normalizeHostname(hostname).split('.');
    for (let i = 0; i < labels.length - 1; i += 1) {
      const zone = await this.find(labels.slice(i).join('.'), options);
      if (zone) return zone;
    }
    return null;
  }

  /**
   * Create a zone, or return the existing zone with the same name in the account.
   * Never creates duplicates: an existing zone is detected before creation, and a
   * creation race (`already exists`) falls back to a lookup.
   */
  async create(input: CreateZoneInput): Promise<CreateZoneResult> {
    const name = normalizeHostname(input.domain);
    const existing = await this.find(name, input);
    if (existing) return withInstructions(existing, false);

    try {
      const raw = await this.api.request<RawZone>({
        method: 'POST',
        path: '/zones',
        body: { name, account: { id: this.api.accountId }, type: input.type ?? 'full' },
        operation: 'zones.create',
        signal: input.signal,
      });
      return withInstructions(mapZone(raw), true);
    } catch (error) {
      if (isDomainPilotError(error, 'CONFLICT')) {
        const raced = await this.find(name, input);
        if (raced) return withInstructions(raced, false);
      }
      throw error;
    }
  }

  /** Assigned nameservers and delegation instructions for a zone. */
  async getNameservers(
    zoneIdOrDomain: string,
    options: RequestOptions = {},
  ): Promise<NameserverInstructions & { status: ZoneStatus; zoneId: string }> {
    const zone = await this.resolve(zoneIdOrDomain, options);
    return { ...nameserverInstructions(zone), status: zone.status, zoneId: zone.id };
  }

  /**
   * Ask Cloudflare to re-check nameserver delegation now. Cloudflare rate-limits this
   * endpoint; failures do not affect the zone.
   */
  async triggerActivationCheck(zoneId: string, options: RequestOptions = {}): Promise<void> {
    await this.api.request({
      method: 'PUT',
      path: `/zones/${encodeURIComponent(zoneId)}/activation_check`,
      operation: 'zones.activationCheck',
      signal: options.signal,
    });
  }

  /** Poll until the zone is `active` or the timeout elapses. Returns the last observed zone. */
  async waitForActive(
    zoneId: string,
    options: PollOptions = {},
  ): Promise<{ zone: Zone; active: boolean; timedOut: boolean }> {
    const result = await poll(async () => {
      const zone = await this.get(zoneId, { signal: options.signal });
      return { done: zone.status === 'active', value: zone };
    }, options);
    return { zone: result.value, active: result.value.status === 'active', timedOut: result.timedOut };
  }

  /**
   * Delete a zone and every DNS record in it. Destructive: requires `confirm: true`.
   * Prefer the removal workflow, which only deletes zones it can prove it manages.
   */
  async delete(input: { zoneId: string; confirm: boolean } & RequestOptions): Promise<void> {
    if (!input.confirm) {
      throw new ConfirmationRequiredError('Deleting a zone removes all of its DNS records; pass confirm: true', {
        zoneId: input.zoneId,
      });
    }
    await this.api.request({
      method: 'DELETE',
      path: `/zones/${encodeURIComponent(input.zoneId)}`,
      operation: 'zones.delete',
      signal: input.signal,
    });
  }

  /** Accept a zone ID or a domain name. */
  async resolve(zoneIdOrDomain: string, options: RequestOptions = {}): Promise<Zone> {
    if (/^[a-f0-9]{32}$/i.test(zoneIdOrDomain)) return this.get(zoneIdOrDomain, options);
    const zone = await this.find(zoneIdOrDomain, options);
    if (!zone) {
      throw new ProviderError('NOT_FOUND', `No Cloudflare zone named ${zoneIdOrDomain} in this account`, {
        provider: 'cloudflare',
        details: { domain: zoneIdOrDomain },
      });
    }
    return zone;
  }
}

function withInstructions(zone: Zone, created: boolean): CreateZoneResult {
  return zone.status === 'active'
    ? { ...zone, created }
    : { ...zone, created, nameserverInstructions: nameserverInstructions(zone) };
}
