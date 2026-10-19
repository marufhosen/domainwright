/**
 * Tenant-bound domain ownership verification.
 *
 * A challenge is a TXT record at `<prefix>.<hostname>` whose value is an HMAC of the
 * tenant ID and hostname, keyed by a secret the platform supplies. Because the token is
 * derived (not stored), the SDK needs no database, and a record published for tenant A
 * can never verify the same hostname for tenant B.
 *
 * The same token doubles as the ownership marker DomainPilot writes into zones it
 * manages, so a zone already claimed by one tenant cannot be silently reused by another.
 */

import { ConfigurationError } from '../core/errors.js';
import type { CheckStatus, RequestOptions } from '../core/types.js';
import { hmacBase64Url, timingSafeEqual } from '../utils/crypto.js';
import { assertNonEmptyString, normalizeHostname } from '../utils/validation.js';
import type { DnsResolver } from '../verification/resolver.js';

export interface OwnershipConfig {
  /**
   * Secret used to derive tokens (at least 32 characters). Keep it stable: rotating it
   * invalidates existing challenges and markers.
   */
  secret: string;
  /** Label prefix for challenge records. Default `_domainpilot`. */
  recordPrefix?: string;
}

export interface OwnershipChallenge {
  hostname: string;
  tenantId: string;
  record: { type: 'TXT'; name: string; content: string };
  /** Human-readable instructions to show the tenant. */
  instructions: string;
}

export interface OwnershipVerificationResult {
  hostname: string;
  status: Extract<CheckStatus, 'passed' | 'pending' | 'failed' | 'error'>;
  /**
   * - `verified`: the expected token is published.
   * - `missing`: no challenge record is published yet.
   * - `other-tenant`: only tokens for a different tenant (or secret) are published.
   * - `lookup-failed`: DNS lookup failed.
   */
  reason: 'verified' | 'missing' | 'other-tenant' | 'lookup-failed';
  record: OwnershipChallenge['record'];
}

const VALUE_PREFIX = 'domainpilot-verification=';

export class OwnershipModule {
  private readonly secret: string;
  readonly recordPrefix: string;

  constructor(
    config: OwnershipConfig,
    private readonly resolver: DnsResolver,
  ) {
    if (typeof config?.secret !== 'string' || config.secret.length < 32) {
      throw new ConfigurationError('ownership.secret must be at least 32 characters', { field: 'ownership.secret' });
    }
    this.secret = config.secret;
    this.recordPrefix = config.recordPrefix ?? '_domainpilot';
    if (!/^_[a-z0-9-]{1,62}$/.test(this.recordPrefix)) {
      throw new ConfigurationError('ownership.recordPrefix must be a label starting with "_"', {
        field: 'ownership.recordPrefix',
      });
    }
  }

  /** Deterministic token for a tenant and hostname. */
  async token(hostname: string, tenantId: string): Promise<string> {
    assertNonEmptyString(tenantId, 'tenantId');
    const name = normalizeHostname(hostname);
    return (await hmacBase64Url(this.secret, `v1:${tenantId}:${name}`)).slice(0, 32);
  }

  /**
   * Short opaque tag identifying a tenant, stored in the comment of DNS records DomainPilot
   * creates. It does not reveal the tenant ID.
   */
  async tenantTag(tenantId: string): Promise<string> {
    assertNonEmptyString(tenantId, 'tenantId');
    return (await hmacBase64Url(this.secret, `tag:v1:${tenantId}`)).slice(0, 16);
  }

  async createChallenge(input: { hostname: string; tenantId: string }): Promise<OwnershipChallenge> {
    const hostname = normalizeHostname(input.hostname);
    const token = await this.token(hostname, input.tenantId);
    const name = `${this.recordPrefix}.${hostname}`;
    return {
      hostname,
      tenantId: input.tenantId,
      record: { type: 'TXT', name, content: `${VALUE_PREFIX}${token}` },
      instructions: `Add a TXT record named ${name} with the value ${VALUE_PREFIX}${token} at the DNS provider for ${hostname}.`,
    };
  }

  /** True when `content` is a DomainPilot challenge value (for any tenant). */
  isChallengeValue(content: string): boolean {
    return content.replace(/^"|"$/g, '').startsWith(VALUE_PREFIX);
  }

  /** True when `content` is the challenge value for this tenant and hostname. */
  async matches(content: string, hostname: string, tenantId: string): Promise<boolean> {
    const expected = `${VALUE_PREFIX}${await this.token(hostname, tenantId)}`;
    return timingSafeEqual(content.replace(/^"|"$/g, ''), expected);
  }

  /**
   * DomainPilot challenge values (for any tenant) published in public DNS for `hostname`.
   * `status: 'error'` means the lookup failed and nothing can be concluded.
   */
  async publishedChallenges(
    hostname: string,
    options: RequestOptions = {},
  ): Promise<{ status: 'ok' | 'error'; record: string; values: string[] }> {
    const record = `${this.recordPrefix}.${normalizeHostname(hostname)}`;
    const answer = await this.resolver.resolve(record, 'TXT', options);
    if (answer.status === 'error') return { status: 'error', record, values: [] };
    return { status: 'ok', record, values: answer.values.filter((v) => this.isChallengeValue(v)) };
  }

  /** Look up the challenge record in public DNS. */
  async verifyChallenge(
    input: { hostname: string; tenantId: string } & RequestOptions,
  ): Promise<OwnershipVerificationResult> {
    const challenge = await this.createChallenge(input);
    const answer = await this.resolver.resolve(challenge.record.name, 'TXT', input);
    const base = { hostname: challenge.hostname, record: challenge.record };
    if (answer.status === 'error') return { ...base, status: 'error', reason: 'lookup-failed' };
    const values = answer.values;
    if (values.some((v) => timingSafeEqual(v, challenge.record.content)))
      return { ...base, status: 'passed', reason: 'verified' };
    if (values.some((v) => this.isChallengeValue(v))) return { ...base, status: 'failed', reason: 'other-tenant' };
    return { ...base, status: 'pending', reason: 'missing' };
  }
}
