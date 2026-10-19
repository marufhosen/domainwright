import { ValidationError } from '../core/errors.js';
import type { RequestOptions } from '../core/types.js';
import type { AvailabilityResult, RegistrarAdapter } from '../registrars/types.js';
import { normalizeHostname, normalizeKeyword, normalizeTld, unique } from '../utils/validation.js';
import { requireCapability } from './capabilities.js';

export interface SearchDomainsInput extends RequestOptions {
  /** Second-level keyword, e.g. `mypropertyapp`. Combined with `tlds`. */
  keyword?: string;
  /** Specific domains to check, e.g. `['mypropertyapp.com']`. */
  domains?: string[];
  /** TLDs to combine with `keyword`, with or without a leading dot. Default `['com']`. */
  tlds?: string[];
  /** Also return registrar suggestions for `keyword`. Default false. */
  includeSuggestions?: boolean;
  /** Re-check suggestions in real time so they are `confirmed`. Default true. */
  confirmSuggestions?: boolean;
  /** Maximum number of suggestions. Default 20. */
  suggestionLimit?: number;
}

export interface SearchResult extends AvailabilityResult {
  /** `exact` for requested names, `suggestion` for registrar-generated alternatives. */
  source: 'exact' | 'suggestion';
}

export interface SearchDomainsResult {
  registrar: string;
  results: SearchResult[];
  /** Convenience subset: confirmed, standard-priced, available results. */
  available: SearchResult[];
}

/** Domain search. Checking or searching never triggers a purchase. */
export class DomainSearch {
  constructor(private readonly registrar: () => RegistrarAdapter) {}

  async search(input: SearchDomainsInput): Promise<SearchDomainsResult> {
    const registrar = this.registrar();
    requireCapability(registrar, 'checkAvailability');
    if (!input.keyword && !input.domains?.length) {
      throw new ValidationError('Provide a keyword or a list of domains to search', { field: 'keyword' });
    }
    const tlds = unique((input.tlds?.length ? input.tlds : ['com']).map(normalizeTld));
    const keyword = input.keyword ? normalizeKeyword(input.keyword) : undefined;
    const exact = unique([
      ...(input.domains ?? []).map((d) => normalizeHostname(d)),
      ...(keyword ? tlds.map((tld) => `${keyword}.${tld}`) : []),
    ]);
    const signal = input.signal ? { signal: input.signal } : {};

    const results: SearchResult[] = (await registrar.checkAvailability(exact, signal)).map((r) => ({
      ...r,
      source: 'exact',
    }));

    if (keyword && input.includeSuggestions) {
      requireCapability(registrar, 'suggestions');
      const suggestions = (await registrar.suggest!(keyword, tlds, signal))
        .filter((s) => !exact.includes(s.domain))
        .slice(0, input.suggestionLimit ?? 20);
      if (input.confirmSuggestions === false || suggestions.length === 0) {
        results.push(...suggestions.map((s) => ({ ...s, confirmed: false, source: 'suggestion' as const })));
      } else {
        const confirmed = await registrar.checkAvailability(
          suggestions.map((s) => s.domain),
          signal,
        );
        results.push(...confirmed.map((r) => ({ ...r, source: 'suggestion' as const })));
      }
    }

    return {
      registrar: registrar.id,
      results,
      available: results.filter((r) => r.availability === 'available' && r.confirmed),
    };
  }

  /** Real-time availability for specific domains. */
  async check(domains: string[], options: RequestOptions = {}): Promise<AvailabilityResult[]> {
    const registrar = this.registrar();
    requireCapability(registrar, 'checkAvailability');
    if (!domains.length) throw new ValidationError('domains must not be empty', { field: 'domains' });
    return registrar.checkAvailability(unique(domains.map((d) => normalizeHostname(d))), options);
  }
}
