import type { RequestOptions } from '../core/types.js';
import type { AvailabilityResult, RegisteredDomain } from '../registrars/types.js';
import type { VerificationReport, VerifyDomainInput } from '../verification/types.js';
import type {
  DomainRegistration,
  PurchaseDomainInput,
  PurchaseDomainResult,
  RenewDomainInput,
  SetNameserversInput,
} from './registration.js';
import type { DomainSearch, SearchDomainsInput, SearchDomainsResult } from './search.js';

/** `client.domains`: registrar operations plus verification. */
export class DomainsModule {
  constructor(
    private readonly searchModule: () => DomainSearch,
    private readonly registrationModule: () => DomainRegistration,
    private readonly verifyFn: (input: VerifyDomainInput) => Promise<VerificationReport>,
  ) {}

  /** Search by keyword and TLDs and/or check specific domains. Never purchases. */
  search(input: SearchDomainsInput): Promise<SearchDomainsResult> {
    return this.searchModule().search(input);
  }

  /** Real-time availability for specific domains. */
  check(domains: string[], options?: RequestOptions): Promise<AvailabilityResult[]> {
    return this.searchModule().check(domains, options);
  }

  /** Register a domain. Requires an explicit `maxPrice`. */
  purchase(input: PurchaseDomainInput): Promise<PurchaseDomainResult> {
    return this.registrationModule().purchase(input);
  }

  /** Registration details (expiry, renewal, nameservers) for a domain in the registrar account. */
  getRegistration(domain: string, options?: RequestOptions): Promise<RegisteredDomain | null> {
    return this.registrationModule().get(domain, options);
  }

  renew(input: RenewDomainInput): Promise<PurchaseDomainResult> {
    return this.registrationModule().renew(input);
  }

  /** Change nameservers at the registrar. Requires `confirm: true`. */
  setNameservers(input: SetNameserversInput): Promise<RegisteredDomain> {
    return this.registrationModule().setNameservers(input);
  }

  /** Run every applicable readiness check and return a detailed report. */
  verify(input: VerifyDomainInput): Promise<VerificationReport> {
    return this.verifyFn(input);
  }
}

export { DomainSearch } from './search.js';
export type { SearchDomainsInput, SearchDomainsResult, SearchResult } from './search.js';
export { DomainRegistration } from './registration.js';
export type {
  PurchaseDomainInput,
  PurchaseDomainResult,
  RenewDomainInput,
  SetNameserversInput,
  SpendingLimit,
} from './registration.js';
