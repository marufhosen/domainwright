/**
 * name.com Core API adapter (https://docs.name.com/api/v1/overview).
 *
 * Why name.com first: its Core API covers real-time availability, keyword suggestions,
 * per-domain pricing (including premium names), registration with an idempotency key,
 * renewal, domain details and nameserver changes, and it offers a sandbox
 * (`api.dev.name.com`) with test credit, so the full purchase path can be exercised
 * without real charges.
 */

import {
  ConfigurationError,
  DomainwrightError,
  type ErrorCode,
  ProviderError,
  PurchaseError,
  isDomainwrightError,
} from '../../core/errors.js';
import { HttpClient, type HttpMethod, type HttpOptions } from '../../core/http.js';
import { type Logger, createSafeLogger } from '../../core/logger.js';
import type { RequestOptions } from '../../core/types.js';
import { normalizeHostname, normalizeKeyword, normalizeTld } from '../../utils/validation.js';
import type {
  AvailabilityResult,
  DomainPricing,
  PurchaseType,
  RegisteredDomain,
  RegistrantContact,
  RegistrarAdapter,
  RegistrarCapabilities,
  RegistrationRequest,
  RegistrationResult,
  RenewalRequest,
} from '../types.js';

export const NAMECOM_BASE_URLS = {
  production: 'https://api.name.com',
  sandbox: 'https://api.dev.name.com',
} as const;

export interface NameComConfig {
  provider: 'namecom';
  /** Account username. Sandbox usernames end in `-test`. */
  username: string;
  /** API token for the selected environment. Never logged or returned. */
  apiToken: string;
  /** Required so production purchases are always an explicit choice. */
  environment: 'production' | 'sandbox';
  /** Override the base URL (testing only). */
  baseUrl?: string;
}

interface RawSearchResult {
  domainName: string;
  sld?: string;
  tld: string;
  purchasable: boolean;
  premium?: boolean;
  purchasePrice?: number;
  purchaseType?: string;
  renewalPrice?: number;
  reason?: string;
}

interface RawDomain {
  domainName: string;
  createDate?: string;
  expireDate?: string;
  autorenewEnabled?: boolean;
  locked?: boolean;
  privacyEnabled?: boolean;
  nameservers?: string[];
  renewalPrice?: number;
}

interface RawPurchaseResponse {
  domain?: RawDomain;
  order?: number;
  totalPaid?: number;
}

const CURRENCY = 'USD';

function mapPurchaseType(value: string | undefined): PurchaseType | undefined {
  if (!value) return undefined;
  if (value === 'registration') return 'registration';
  if (value.startsWith('aftermarket')) return 'aftermarket';
  if (value === 'expiring' || value === 'backorder') return value;
  return undefined;
}

export function validateNameComConfig(config: NameComConfig): void {
  if (config.provider !== 'namecom') throw new ConfigurationError('registrar.provider must be "namecom"');
  if (typeof config.username !== 'string' || !config.username.trim()) {
    throw new ConfigurationError('registrar.username is required', { field: 'registrar.username' });
  }
  if (typeof config.apiToken !== 'string' || config.apiToken.trim().length < 8) {
    throw new ConfigurationError('registrar.apiToken is required', { field: 'registrar.apiToken' });
  }
  if (config.environment !== 'production' && config.environment !== 'sandbox') {
    throw new ConfigurationError('registrar.environment must be "production" or "sandbox"', {
      field: 'registrar.environment',
    });
  }
  const isTestUser = config.username.trim().endsWith('-test');
  if (config.environment === 'sandbox' && !isTestUser) {
    throw new ConfigurationError('name.com sandbox usernames end in "-test"; check that sandbox credentials are used', {
      field: 'registrar.username',
    });
  }
  if (config.environment === 'production' && isTestUser) {
    throw new ConfigurationError('A "-test" (sandbox) username was supplied for the production environment', {
      field: 'registrar.username',
    });
  }
}

export class NameComRegistrar implements RegistrarAdapter {
  readonly id = 'namecom';
  readonly displayName = 'name.com';
  readonly capabilities: RegistrarCapabilities = {
    checkAvailability: true,
    suggestions: true,
    pricing: true,
    register: true,
    idempotentRegistration: true,
    renew: true,
    getDomain: true,
    setNameservers: true,
  };
  readonly environment: 'production' | 'sandbox';

  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly logger: Logger;

  constructor(config: NameComConfig, options: { http?: HttpOptions | HttpClient; logger?: Logger } = {}) {
    validateNameComConfig(config);
    this.logger = createSafeLogger(options.logger);
    this.http = options.http instanceof HttpClient ? options.http : new HttpClient(options.http, this.logger);
    this.environment = config.environment;
    this.baseUrl = config.baseUrl ?? NAMECOM_BASE_URLS[config.environment];
    this.authorization = `Basic ${btoa(`${config.username.trim()}:${config.apiToken.trim()}`)}`;
  }

  async checkAvailability(domains: string[], options: RequestOptions = {}): Promise<AvailabilityResult[]> {
    const names = domains.map((d) => normalizeHostname(d));
    const results: AvailabilityResult[] = [];
    // The endpoint accepts at most 50 names per request.
    for (let i = 0; i < names.length; i += 50) {
      const batch = names.slice(i, i + 50);
      const body = await this.call<{ results?: RawSearchResult[] }>('POST', '/core/v1/domains:checkAvailability', {
        body: { domainNames: batch, purchaseType: 'registration' },
        idempotent: true, // read-only despite POST
        operation: 'namecom.checkAvailability',
        signal: options.signal,
      });
      const byName = new Map((body.results ?? []).map((r) => [r.domainName.toLowerCase(), r]));
      for (const name of batch) {
        const raw = byName.get(name);
        results.push(raw ? this.mapResult(raw, true) : this.unknown(name, 'Not returned by name.com'));
      }
    }
    return results;
  }

  async suggest(
    keyword: string,
    tlds: string[] | undefined,
    options: RequestOptions = {},
  ): Promise<AvailabilityResult[]> {
    const body = await this.call<{ results?: RawSearchResult[] }>('POST', '/core/v1/domains:search', {
      body: {
        keyword: normalizeKeyword(keyword),
        ...(tlds?.length ? { tldFilter: tlds.map(normalizeTld).slice(0, 50) } : {}),
        purchaseType: 'registration',
        timeout: 5_000,
      },
      idempotent: true,
      operation: 'namecom.search',
      signal: options.signal,
    });
    // Suggestions are not treated as confirmed availability; confirm with checkAvailability.
    return (body.results ?? []).map((r) => this.mapResult(r, false));
  }

  async getPricing(domain: string, years: number, options: RequestOptions = {}): Promise<DomainPricing> {
    const name = normalizeHostname(domain);
    const body = await this.call<{
      premium?: boolean;
      purchasePrice?: number | null;
      renewalPrice?: number | null;
      transferPrice?: number | null;
    }>('GET', `/core/v1/domains/${encodeURIComponent(name)}:getPricing`, {
      query: { years },
      operation: 'namecom.getPricing',
      signal: options.signal,
    });
    const price = (v: number | null | undefined): DomainPricing['registrationPrice'] =>
      typeof v === 'number' ? { amount: v, currency: CURRENCY } : null;
    return {
      domain: name,
      years,
      premium: body.premium ?? false,
      registrationPrice: price(body.purchasePrice),
      renewalPrice: price(body.renewalPrice),
      transferPrice: price(body.transferPrice),
    };
  }

  async register(request: RegistrationRequest, options: RequestOptions = {}): Promise<RegistrationResult> {
    const name = normalizeHostname(request.domain);
    const domain: Record<string, unknown> = { domainName: name };
    if (request.privacy !== undefined) domain.privacyEnabled = request.privacy;
    if (request.autoRenew !== undefined) domain.autorenewEnabled = request.autoRenew;
    if (request.nameservers?.length) domain.nameservers = request.nameservers;
    if (request.contacts) {
      const contacts: Record<string, unknown> = {};
      for (const role of ['registrant', 'admin', 'tech', 'billing'] as const) {
        const contact = request.contacts[role];
        if (contact) contacts[role] = mapContact(contact);
      }
      domain.contacts = contacts;
    }

    let response: { body: RawPurchaseResponse; headers: Headers };
    try {
      response = await this.callWithHeaders<RawPurchaseResponse>('POST', '/core/v1/domains', {
        body: {
          domain,
          years: request.years,
          ...(request.purchasePrice === undefined ? {} : { purchasePrice: request.purchasePrice }),
          ...(request.tldRequirements ? { tldRequirements: request.tldRequirements } : {}),
        },
        headers: { 'x-idempotency-key': request.idempotencyKey },
        idempotent: false,
        operation: 'namecom.createDomain',
        signal: options.signal,
        purchase: true,
      });
    } catch (error) {
      throw this.purchaseError(error, name, request.idempotencyKey);
    }

    const created = response.body.domain;
    return {
      domain: created?.domainName ?? name,
      status: 'registered',
      ...(response.body.order === undefined ? {} : { orderId: String(response.body.order) }),
      ...(response.body.totalPaid === undefined
        ? {}
        : { totalPaid: { amount: response.body.totalPaid, currency: CURRENCY } }),
      ...(created?.expireDate ? { expiresAt: created.expireDate } : {}),
      replayed: response.headers.get('x-idempotent-replay') === '1',
      registrar: this.id,
    };
  }

  async renew(request: RenewalRequest, options: RequestOptions = {}): Promise<RegistrationResult> {
    const name = normalizeHostname(request.domain);
    let response: { body: RawPurchaseResponse; headers: Headers };
    try {
      response = await this.callWithHeaders<RawPurchaseResponse>(
        'POST',
        `/core/v1/domains/${encodeURIComponent(name)}:renew`,
        {
          body: {
            years: request.years,
            ...(request.purchasePrice === undefined ? {} : { purchasePrice: request.purchasePrice }),
          },
          ...(request.idempotencyKey ? { headers: { 'x-idempotency-key': request.idempotencyKey } } : {}),
          idempotent: false,
          operation: 'namecom.renewDomain',
          signal: options.signal,
          purchase: true,
        },
      );
    } catch (error) {
      throw this.purchaseError(error, name, request.idempotencyKey);
    }
    return {
      domain: name,
      status: 'registered',
      ...(response.body.order === undefined ? {} : { orderId: String(response.body.order) }),
      ...(response.body.totalPaid === undefined
        ? {}
        : { totalPaid: { amount: response.body.totalPaid, currency: CURRENCY } }),
      ...(response.body.domain?.expireDate ? { expiresAt: response.body.domain.expireDate } : {}),
      replayed: response.headers.get('x-idempotent-replay') === '1',
      registrar: this.id,
    };
  }

  async getDomain(domain: string, options: RequestOptions = {}): Promise<RegisteredDomain | null> {
    const name = normalizeHostname(domain);
    try {
      const raw = await this.call<RawDomain>('GET', `/core/v1/domains/${encodeURIComponent(name)}`, {
        operation: 'namecom.getDomain',
        signal: options.signal,
      });
      return this.mapDomain(raw);
    } catch (error) {
      if (isDomainwrightError(error, 'NOT_FOUND')) return null;
      throw error;
    }
  }

  async setNameservers(domain: string, nameservers: string[], options: RequestOptions = {}): Promise<RegisteredDomain> {
    const name = normalizeHostname(domain);
    const servers = nameservers.map((ns) => normalizeHostname(ns, { field: 'nameservers' }));
    const raw = await this.call<RawDomain>('POST', `/core/v1/domains/${encodeURIComponent(name)}:setNameservers`, {
      body: { nameservers: servers },
      idempotent: true, // setting the same list twice has the same effect
      operation: 'namecom.setNameservers',
      signal: options.signal,
    });
    return this.mapDomain(raw);
  }

  private mapResult(raw: RawSearchResult, confirmed: boolean): AvailabilityResult {
    const purchaseType = mapPurchaseType(raw.purchaseType);
    const standard = purchaseType === undefined || purchaseType === 'registration';
    return {
      domain: raw.domainName.toLowerCase(),
      tld: raw.tld,
      availability: availabilityOf(raw, standard),
      confirmed,
      premium: raw.premium ?? false,
      ...(purchaseType ? { purchaseType } : {}),
      ...(typeof raw.purchasePrice === 'number'
        ? { registrationPrice: { amount: raw.purchasePrice, currency: CURRENCY } }
        : {}),
      ...(typeof raw.renewalPrice === 'number'
        ? { renewalPrice: { amount: raw.renewalPrice, currency: CURRENCY } }
        : {}),
      ...(raw.reason ? { reason: raw.reason } : {}),
      registrar: this.id,
    };
  }

  private unknown(domain: string, reason: string): AvailabilityResult {
    return {
      domain,
      tld: domain.split('.').slice(1).join('.'),
      availability: 'unknown',
      confirmed: false,
      premium: false,
      reason,
      registrar: this.id,
    };
  }

  private mapDomain(raw: RawDomain): RegisteredDomain {
    return {
      domain: raw.domainName.toLowerCase(),
      registrar: this.id,
      createdAt: raw.createDate ?? null,
      expiresAt: raw.expireDate ?? null,
      autoRenew: raw.autorenewEnabled ?? null,
      locked: raw.locked ?? null,
      privacy: raw.privacyEnabled ?? null,
      nameservers: (raw.nameservers ?? []).map((ns) => ns.toLowerCase()),
      ...(typeof raw.renewalPrice === 'number'
        ? { renewalPrice: { amount: raw.renewalPrice, currency: CURRENCY } }
        : {}),
    };
  }

  private purchaseError(error: unknown, domain: string, idempotencyKey: string | undefined): DomainwrightError {
    const details = { domain, ...(idempotencyKey ? { idempotencyKey } : {}) };
    if (!isDomainwrightError(error)) {
      return new PurchaseError('PURCHASE_OUTCOME_UNKNOWN', `The outcome of the purchase of ${domain} is unknown`, {
        provider: this.id,
        details,
        cause: error,
      });
    }
    if (
      error.code === 'ABORTED' ||
      error.code === 'TIMEOUT' ||
      error.code === 'NETWORK_ERROR' ||
      (error.status ?? 0) >= 500
    ) {
      return new PurchaseError(
        'PURCHASE_OUTCOME_UNKNOWN',
        `No definitive response was received for the purchase of ${domain}. Check the registrar account ` +
          `before retrying; repeating the request with the same idempotency key within one hour is safe.`,
        { provider: this.id, ...(error.status === undefined ? {} : { status: error.status }), details, cause: error },
      );
    }
    if (error.status === 402) {
      return new PurchaseError(
        'PAYMENT_FAILED',
        `Payment failed for ${domain}: ${error.providerErrors[0]?.message ?? 'declined'}`,
        {
          provider: this.id,
          status: 402,
          providerErrors: error.providerErrors,
          details,
        },
      );
    }
    if (error.status === 400 || error.status === 422 || error.status === 451) {
      return new PurchaseError(
        'PURCHASE_FAILED',
        `name.com rejected the purchase of ${domain}: ${error.providerErrors[0]?.message ?? 'rejected'}`,
        {
          provider: this.id,
          status: error.status,
          retryable: error.status === 422,
          providerErrors: error.providerErrors,
          details,
        },
      );
    }
    return error;
  }

  private async call<T>(method: HttpMethod, path: string, init: CallInit): Promise<T> {
    return (await this.callWithHeaders<T>(method, path, init)).body;
  }

  private async callWithHeaders<T>(
    method: HttpMethod,
    path: string,
    init: CallInit,
  ): Promise<{ body: T; headers: Headers }> {
    const response = await this.http.request({
      method,
      url: `${this.baseUrl}${path}`,
      ...(init.query ? { query: init.query } : {}),
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: { authorization: this.authorization, ...init.headers },
      ...(init.idempotent === undefined ? {} : { idempotent: init.idempotent }),
      ...(init.purchase ? { retry: { maxAttempts: 2 } } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      operation: init.operation,
      provider: this.id,
    });
    if (response.status >= 200 && response.status < 300) {
      return { body: (response.body ?? {}) as T, headers: response.headers };
    }
    throw toNameComError(response.status, response.body, init.operation);
  }
}

interface CallInit {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  idempotent?: boolean;
  operation: string;
  signal?: AbortSignal | undefined;
  /** Purchases only retry when the server rejected the request unprocessed (HTTP 429), once. */
  purchase?: boolean;
}

const TRANSIENT_REASON = /maintenance|timeout|timed out|try again|temporar|unavailable|error/i;

function availabilityOf(raw: RawSearchResult, standard: boolean): AvailabilityResult['availability'] {
  if (raw.purchasable) return standard ? 'available' : 'unavailable';
  // A reason such as registry maintenance means availability could not be determined.
  return raw.reason && TRANSIENT_REASON.test(raw.reason) ? 'unknown' : 'unavailable';
}

function mapContact(contact: RegistrantContact): Record<string, string> {
  const out: Record<string, string> = {
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    address1: contact.address1,
    city: contact.city,
    zip: contact.zip,
    country: contact.country,
  };
  if (contact.companyName) out.companyName = contact.companyName;
  if (contact.address2) out.address2 = contact.address2;
  if (contact.state) out.state = contact.state;
  return out;
}

export function toNameComError(status: number, body: unknown, operation: string): ProviderError {
  const payload = (body ?? {}) as { message?: unknown; details?: unknown };
  const message = typeof payload.message === 'string' ? payload.message.slice(0, 300) : `HTTP ${status}`;
  let code: ErrorCode = 'PROVIDER_ERROR';
  if (status === 401) code = 'AUTHENTICATION_FAILED';
  else if (status === 403) code = 'PERMISSION_DENIED';
  else if (status === 404) code = 'NOT_FOUND';
  else if (status === 409) code = 'CONFLICT';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status === 400 || status === 415) code = 'VALIDATION_ERROR';
  return new ProviderError(code, `name.com ${operation} failed: ${message}`, {
    provider: 'namecom',
    status,
    retryable: status === 429 || status === 422 || status >= 500,
    providerErrors: [{ code: status, message }],
    details: { operation },
  });
}
