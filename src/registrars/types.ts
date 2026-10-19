/**
 * Registrar provider adapter contract.
 *
 * Adapters isolate provider-specific APIs. Each adapter declares which operations it
 * supports through `capabilities`; DomainPilot never assumes a registrar supports an
 * operation it does not declare, and throws `UNSUPPORTED_OPERATION` instead.
 */

import type { RequestOptions } from '../core/types.js';

export interface RegistrarCapabilities {
  /** Real-time availability and price for specific domains. */
  checkAvailability: boolean;
  /** Keyword-based suggestions. */
  suggestions: boolean;
  /** Price lookups for a specific domain and term (needed for premium names). */
  pricing: boolean;
  /** New registrations. */
  register: boolean;
  /** Registrations accept an idempotency key that makes retries safe. */
  idempotentRegistration: boolean;
  renew: boolean;
  /** Read registration details for domains in the registrar account. */
  getDomain: boolean;
  /** Change nameservers for domains in the registrar account. */
  setNameservers: boolean;
}

export type PurchaseType = 'registration' | 'aftermarket' | 'expiring' | 'backorder';

export interface Price {
  /** Amount in major units (e.g. 12.99). */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
}

/**
 * - `available`: the registrar confirmed the domain can be registered now.
 * - `unavailable`: the registrar confirmed it cannot be registered.
 * - `unknown`: availability could not be confirmed (registry maintenance, provider error,
 *   unsupported TLD, or an unconfirmed suggestion).
 */
export type Availability = 'available' | 'unavailable' | 'unknown';

export interface AvailabilityResult {
  domain: string;
  tld: string;
  availability: Availability;
  /** True only when the registrar's real-time availability check produced this result. */
  confirmed: boolean;
  premium: boolean;
  purchaseType?: PurchaseType;
  /** Price for the minimum registration term. */
  registrationPrice?: Price;
  renewalPrice?: Price;
  reason?: string;
  registrar: string;
}

export interface DomainPricing {
  domain: string;
  years: number;
  premium: boolean;
  /** `null` when the registry does not currently accept registrations for this term. */
  registrationPrice: Price | null;
  renewalPrice: Price | null;
  transferPrice: Price | null;
}

export interface RegistrantContact {
  firstName: string;
  lastName: string;
  companyName?: string;
  email: string;
  phone: string;
  address1: string;
  address2?: string;
  city: string;
  state?: string;
  zip: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
}

export interface RegistrationRequest {
  domain: string;
  years: number;
  /**
   * Exact price for premium / non-standard purchases. Must match the registrar's quote.
   * Omit for standard registrations.
   */
  purchasePrice?: number;
  purchaseType?: PurchaseType;
  /** Key that makes repeating this exact request safe, when the registrar supports it. */
  idempotencyKey: string;
  contacts?: {
    registrant?: RegistrantContact;
    admin?: RegistrantContact;
    tech?: RegistrantContact;
    billing?: RegistrantContact;
  };
  nameservers?: string[];
  privacy?: boolean;
  autoRenew?: boolean;
  /** Registry-specific fields, passed through unchanged. */
  tldRequirements?: Record<string, string>;
}

export type RegistrationStatus = 'registered' | 'pending' | 'action-required';

export interface RegistrationResult {
  domain: string;
  status: RegistrationStatus;
  orderId?: string;
  totalPaid?: Price;
  expiresAt?: string;
  /** The registrar returned a cached result for a repeated idempotency key. */
  replayed: boolean;
  registrar: string;
}

export interface RegisteredDomain {
  domain: string;
  registrar: string;
  createdAt: string | null;
  expiresAt: string | null;
  autoRenew: boolean | null;
  locked: boolean | null;
  privacy: boolean | null;
  nameservers: string[];
  renewalPrice?: Price;
}

export interface RenewalRequest {
  domain: string;
  years: number;
  purchasePrice?: number;
  idempotencyKey?: string;
}

export interface RegistrarAdapter {
  /** Stable identifier, e.g. `namecom`. */
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: RegistrarCapabilities;

  checkAvailability(domains: string[], options?: RequestOptions): Promise<AvailabilityResult[]>;
  suggest?(keyword: string, tlds: string[] | undefined, options?: RequestOptions): Promise<AvailabilityResult[]>;
  getPricing?(domain: string, years: number, options?: RequestOptions): Promise<DomainPricing>;
  /**
   * Submit a registration. Implementations must NOT retry automatically and must throw
   * `PURCHASE_OUTCOME_UNKNOWN` when the request may have been processed but no response
   * was received.
   */
  register?(request: RegistrationRequest, options?: RequestOptions): Promise<RegistrationResult>;
  renew?(request: RenewalRequest, options?: RequestOptions): Promise<RegistrationResult>;
  /** Returns `null` when the domain is not in this registrar account. */
  getDomain?(domain: string, options?: RequestOptions): Promise<RegisteredDomain | null>;
  setNameservers?(domain: string, nameservers: string[], options?: RequestOptions): Promise<RegisteredDomain>;
}
