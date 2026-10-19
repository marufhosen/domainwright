import { ConfirmationRequiredError, PurchaseError, ValidationError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { RequestOptions } from '../core/types.js';
import type {
  Price,
  RegisteredDomain,
  RegistrantContact,
  RegistrarAdapter,
  RegistrationResult,
} from '../registrars/types.js';
import { randomId } from '../utils/crypto.js';
import { assertPositiveInteger, normalizeHostname } from '../utils/validation.js';
import { requireCapability, supports } from './capabilities.js';

export interface SpendingLimit {
  /** Maximum total amount you authorize for this operation. */
  amount: number;
  /** Currency of `amount`. Must match the registrar's currency. Default `USD`. */
  currency?: string;
}

export interface PurchaseDomainInput extends RequestOptions {
  domain: string;
  /** Registration term in years. Default 1. */
  years?: number;
  /**
   * Explicit spending authorization. The purchase is refused when the registrar's quote for
   * the full term exceeds this limit. There is no default: every purchase must state one.
   */
  maxPrice: SpendingLimit | number;
  /** Allow registry-premium prices. Default false. */
  allowPremium?: boolean;
  /**
   * Idempotency key. Generated when omitted and always returned; persist it before calling so
   * an interrupted purchase can be repeated safely (name.com honours keys for one hour).
   */
  idempotencyKey?: string;
  contacts?: {
    registrant?: RegistrantContact;
    admin?: RegistrantContact;
    tech?: RegistrantContact;
    billing?: RegistrantContact;
  };
  /** Nameservers to set at registration. Defaults to the registrar account default. */
  nameservers?: string[];
  privacy?: boolean;
  autoRenew?: boolean;
  tldRequirements?: Record<string, string>;
}

export interface PurchaseDomainResult extends Omit<RegistrationResult, 'status'> {
  /** `already-owned` means the domain was already in the registrar account; nothing was charged. */
  status: RegistrationResult['status'] | 'already-owned';
  idempotencyKey: string;
  /** Registrar quote the purchase was authorized against. */
  quotedPrice?: Price;
}

export interface RenewDomainInput extends RequestOptions {
  domain: string;
  years?: number;
  maxPrice: SpendingLimit | number;
  idempotencyKey?: string;
}

export interface SetNameserversInput extends RequestOptions {
  domain: string;
  nameservers: string[];
  /** Required: changing nameservers moves the domain's DNS. */
  confirm: boolean;
}

function toLimit(limit: SpendingLimit | number | undefined): Required<SpendingLimit> {
  if (limit === undefined || limit === null) {
    throw new PurchaseError('PURCHASE_NOT_AUTHORIZED', 'maxPrice is required to authorize a purchase');
  }
  const value =
    typeof limit === 'number'
      ? { amount: limit, currency: 'USD' }
      : { amount: limit.amount, currency: limit.currency ?? 'USD' };
  if (!Number.isFinite(value.amount) || value.amount <= 0) {
    throw new ValidationError('maxPrice.amount must be a positive number', { field: 'maxPrice' });
  }
  return { amount: value.amount, currency: value.currency.toUpperCase() };
}

/** Registration, renewal and registrar-side domain management. */
export class DomainRegistration {
  constructor(
    private readonly registrar: () => RegistrarAdapter,
    private readonly logger: Logger,
  ) {}

  /**
   * Register a domain. Safeguards, in order:
   * 1. the domain must not already be in the registrar account (returns `already-owned`);
   * 2. real-time availability must be confirmed;
   * 3. premium prices require `allowPremium`;
   * 4. the quote for the full term must not exceed `maxPrice`;
   * 5. the request carries an idempotency key and is never retried automatically.
   */
  async purchase(input: PurchaseDomainInput): Promise<PurchaseDomainResult> {
    const registrar = this.registrar();
    requireCapability(registrar, 'register');
    const domain = normalizeHostname(input.domain);
    const years = input.years ?? 1;
    assertPositiveInteger(years, 'years', 10);
    const limit = toLimit(input.maxPrice);
    const idempotencyKey = input.idempotencyKey ?? randomId();
    const signal = input.signal ? { signal: input.signal } : {};

    if (supports(registrar, 'getDomain')) {
      const owned = await registrar.getDomain!(domain, signal);
      if (owned) {
        this.logger.info('purchase skipped: domain already in registrar account', { domain, registrar: registrar.id });
        return {
          domain,
          status: 'already-owned',
          ...(owned.expiresAt ? { expiresAt: owned.expiresAt } : {}),
          replayed: false,
          registrar: registrar.id,
          idempotencyKey,
        };
      }
    }

    const [availability] = await registrar.checkAvailability([domain], signal);
    if (!availability || availability.availability !== 'available' || !availability.confirmed) {
      const unknown = !availability || availability.availability === 'unknown';
      throw new PurchaseError(
        'DOMAIN_UNAVAILABLE',
        unknown ? `Availability of ${domain} could not be confirmed` : `${domain} is not available for registration`,
        {
          provider: registrar.id,
          retryable: unknown,
          details: { domain, ...(availability?.reason ? { reason: availability.reason } : {}) },
        },
      );
    }
    if (availability.premium && !input.allowPremium) {
      throw new PurchaseError(
        'PURCHASE_NOT_AUTHORIZED',
        `${domain} is a premium domain; pass allowPremium: true to buy it`,
        {
          provider: registrar.id,
          details: { domain, ...(availability.registrationPrice ? { price: availability.registrationPrice } : {}) },
        },
      );
    }

    let quote: Price | undefined;
    if (supports(registrar, 'pricing')) {
      const pricing = await registrar.getPricing!(domain, years, signal);
      if (!pricing.registrationPrice) {
        throw new PurchaseError(
          'DOMAIN_UNAVAILABLE',
          `The registry is not accepting ${years}-year registrations for ${domain}`,
          {
            provider: registrar.id,
            details: { domain, years },
          },
        );
      }
      quote = pricing.registrationPrice;
    } else if (availability.registrationPrice) {
      quote = {
        amount: availability.registrationPrice.amount * years,
        currency: availability.registrationPrice.currency,
      };
    }
    if (!quote) {
      throw new PurchaseError(
        'PURCHASE_NOT_AUTHORIZED',
        `No price quote is available for ${domain}; refusing to purchase without one`,
        {
          provider: registrar.id,
          details: { domain },
        },
      );
    }
    if (quote.currency.toUpperCase() !== limit.currency || quote.amount > limit.amount) {
      throw new PurchaseError(
        'PURCHASE_NOT_AUTHORIZED',
        `Quoted ${quote.amount} ${quote.currency} exceeds the authorized ${limit.amount} ${limit.currency}`,
        {
          provider: registrar.id,
          details: { domain, quote, maxPrice: limit },
        },
      );
    }

    this.logger.info('submitting domain registration', { domain, years, registrar: registrar.id, idempotencyKey });
    const result = await registrar.register!(
      {
        domain,
        years,
        idempotencyKey,
        ...(availability.premium ? { purchasePrice: quote.amount } : {}),
        ...(input.contacts ? { contacts: input.contacts } : {}),
        ...(input.nameservers
          ? { nameservers: input.nameservers.map((ns) => normalizeHostname(ns, { field: 'nameservers' })) }
          : {}),
        ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
        ...(input.autoRenew === undefined ? {} : { autoRenew: input.autoRenew }),
        ...(input.tldRequirements ? { tldRequirements: input.tldRequirements } : {}),
      },
      signal,
    );
    return { ...result, idempotencyKey, quotedPrice: quote };
  }

  /** Registration details for a domain in the registrar account, or `null`. */
  async get(domain: string, options: RequestOptions = {}): Promise<RegisteredDomain | null> {
    const registrar = this.registrar();
    requireCapability(registrar, 'getDomain');
    return registrar.getDomain!(normalizeHostname(domain), options);
  }

  async renew(input: RenewDomainInput): Promise<PurchaseDomainResult> {
    const registrar = this.registrar();
    requireCapability(registrar, 'renew');
    const domain = normalizeHostname(input.domain);
    const years = input.years ?? 1;
    assertPositiveInteger(years, 'years', 10);
    const limit = toLimit(input.maxPrice);
    const idempotencyKey = input.idempotencyKey ?? randomId();
    const signal = input.signal ? { signal: input.signal } : {};
    requireCapability(registrar, 'pricing');
    const pricing = await registrar.getPricing!(domain, years, signal);
    if (!pricing.renewalPrice) {
      throw new PurchaseError('PURCHASE_FAILED', `${domain} cannot currently be renewed for ${years} year(s)`, {
        provider: registrar.id,
      });
    }
    if (pricing.renewalPrice.currency.toUpperCase() !== limit.currency || pricing.renewalPrice.amount > limit.amount) {
      throw new PurchaseError(
        'PURCHASE_NOT_AUTHORIZED',
        `Renewal quote ${pricing.renewalPrice.amount} ${pricing.renewalPrice.currency} exceeds the authorized limit`,
        {
          provider: registrar.id,
          details: { domain, quote: pricing.renewalPrice, maxPrice: limit },
        },
      );
    }
    const result = await registrar.renew!(
      { domain, years, idempotencyKey, ...(pricing.premium ? { purchasePrice: pricing.renewalPrice.amount } : {}) },
      signal,
    );
    return { ...result, idempotencyKey, quotedPrice: pricing.renewalPrice };
  }

  /** Change nameservers at the registrar. Requires `confirm: true`. */
  async setNameservers(input: SetNameserversInput): Promise<RegisteredDomain> {
    if (!input.confirm) {
      throw new ConfirmationRequiredError('Changing nameservers moves DNS for the whole domain; pass confirm: true', {
        domain: input.domain,
      });
    }
    const registrar = this.registrar();
    requireCapability(registrar, 'setNameservers');
    if (!input.nameservers.length) throw new ValidationError('nameservers must not be empty', { field: 'nameservers' });
    return registrar.setNameservers!(
      normalizeHostname(input.domain),
      input.nameservers.map((ns) => normalizeHostname(ns, { field: 'nameservers' })),
      input.signal ? { signal: input.signal } : {},
    );
  }
}
