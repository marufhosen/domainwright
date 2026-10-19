import { ValidationError } from '../core/errors.js';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export interface HostnameOptions {
  /** Allow a leading `*.` label. Default false. */
  allowWildcard?: boolean;
  /** Allow labels starting with `_` (e.g. `_dmarc`, `_domainpilot`). Default false. */
  allowUnderscore?: boolean;
  /** Field name used in error messages. */
  field?: string;
}

/**
 * Normalize a domain or hostname: trim, lowercase, drop a trailing dot and convert
 * internationalized names to punycode (via the WHATWG URL parser, which is available
 * in Node.js and Cloudflare Workers). Throws `ValidationError` for invalid input.
 */
export function normalizeHostname(input: string, options: HostnameOptions = {}): string {
  const field = options.field ?? 'domain';
  if (typeof input !== 'string') throw new ValidationError(`${field} must be a string`, { field });
  let value = input.trim().toLowerCase();
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (!value) throw new ValidationError(`${field} must not be empty`, { field });
  if (/[/:@?#\s]/.test(value)) {
    throw new ValidationError(`${field} must be a bare hostname without scheme, port or path`, { field, value });
  }

  let wildcard = false;
  if (value.startsWith('*.')) {
    if (!options.allowWildcard) throw new ValidationError(`${field} must not be a wildcard`, { field, value });
    wildcard = true;
    value = value.slice(2);
  }

  if (!/^[ -~]*$/.test(value)) {
    try {
      value = new URL(`http://${value}`).hostname;
    } catch {
      throw new ValidationError(`${field} is not a valid internationalized domain name`, { field, value: input });
    }
  }

  if (IPV4.test(value) || value.includes(':')) {
    throw new ValidationError(`${field} must be a domain name, not an IP address`, { field, value });
  }
  if (value.length > 253) throw new ValidationError(`${field} exceeds 253 characters`, { field });

  const labels = value.split('.');
  if (labels.length < 2) throw new ValidationError(`${field} must include a top-level domain`, { field, value });
  labels.forEach((label, index) => {
    const isUnderscore = options.allowUnderscore && index < labels.length - 2 && /^_[a-z0-9-]{1,62}$/.test(label);
    if (!isUnderscore && !LABEL.test(label)) {
      throw new ValidationError(`${field} contains an invalid label "${label}"`, { field, value });
    }
  });
  const tld = labels[labels.length - 1] ?? '';
  if (/^\d+$/.test(tld)) throw new ValidationError(`${field} has a numeric top-level domain`, { field, value });

  return wildcard ? `*.${value}` : value;
}

/** True when `hostname` equals `zone` or is a subdomain of it. */
export function isWithinZone(hostname: string, zone: string): boolean {
  return hostname === zone || hostname.endsWith(`.${zone}`);
}

/**
 * Resolve a record name relative to a zone. Accepts `@`, a relative label such as
 * `www`, or a fully qualified name inside the zone.
 */
export function resolveRecordName(name: string, zone: string): string {
  const trimmed = name.trim().toLowerCase().replace(/\.$/, '');
  if (trimmed === '@' || trimmed === '') return zone;
  const fqdn = isWithinZone(trimmed, zone) ? trimmed : `${trimmed}.${zone}`;
  const normalized = normalizeHostname(fqdn, { allowUnderscore: true, allowWildcard: true, field: 'name' });
  if (!isWithinZone(normalized.replace(/^\*\./, ''), zone) && normalized !== `*.${zone}`) {
    throw new ValidationError(`Record name "${name}" is outside zone ${zone}`, { name, zone });
  }
  return normalized;
}

export function isIPv4(value: string): boolean {
  return IPV4.test(value);
}

export function isIPv6(value: string): boolean {
  if (!value.includes(':') || /[^0-9a-f:.]/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

/** Normalize a TLD argument (`.com`, `com`, `COM`) to `com`. */
export function normalizeTld(input: string): string {
  const value = input.trim().toLowerCase().replace(/^\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(value) || /^\d+$/.test(value)) {
    throw new ValidationError(`Invalid TLD "${input}"`, { field: 'tlds', value: input });
  }
  return value;
}

/** Normalize a search keyword into a valid second-level label, e.g. `My Property App` -> `mypropertyapp`. */
export function normalizeKeyword(input: string): string {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '')
    .replace(/[^a-z0-9-]/g, '');
  if (!LABEL.test(value)) {
    throw new ValidationError('keyword must contain letters, digits or hyphens (1-63 characters)', {
      field: 'keyword',
    });
  }
  return value;
}

export function assertPositiveInteger(value: unknown, field: string, max?: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new ValidationError(`${field} must be an integer between 1 and ${max ?? 'infinity'}`, { field });
  }
}

export function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string`, { field });
  }
}

/** Return unique values preserving order. */
export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Compare two nameserver sets ignoring case, order and trailing dots. */
export function sameNameservers(a: readonly string[], b: readonly string[]): boolean {
  const norm = (list: readonly string[]): string[] =>
    unique(list.map((ns) => ns.trim().toLowerCase().replace(/\.$/, ''))).sort();
  const left = norm(a);
  const right = norm(b);
  return left.length === right.length && left.every((ns, i) => ns === right[i]);
}
