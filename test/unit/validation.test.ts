import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/index.js';
import { validateRecord } from '../../src/cloudflare/dns.js';
import { validateRoutePattern, routeMatchesHostname } from '../../src/cloudflare/workers.js';
import { certificateCovers } from '../../src/cloudflare/certificates.js';
import {
  isIPv6,
  normalizeHostname,
  normalizeKeyword,
  normalizeTld,
  resolveRecordName,
  sameNameservers,
} from '../../src/utils/validation.js';

describe('normalizeHostname', () => {
  it('lowercases, trims and drops the trailing dot', () => {
    expect(normalizeHostname('  Example.COM. ')).toBe('example.com');
  });
  it('converts IDNs to punycode', () => {
    expect(normalizeHostname('bücher.de')).toBe('xn--bcher-kva.de');
  });
  it.each([
    '',
    'localhost',
    '192.168.0.1',
    '::1',
    'https://example.com',
    'example.com/path',
    '-bad.com',
    'a..com',
    'exa_mple.com',
    'example.123',
    `${'a'.repeat(64)}.com`,
  ])('rejects %s', (value) => {
    expect(() => normalizeHostname(value)).toThrow(ValidationError);
  });
  it('handles wildcards and underscores only when allowed', () => {
    expect(() => normalizeHostname('*.example.com')).toThrow(ValidationError);
    expect(normalizeHostname('*.example.com', { allowWildcard: true })).toBe('*.example.com');
    expect(normalizeHostname('_domainpilot.example.com', { allowUnderscore: true })).toBe('_domainpilot.example.com');
  });
});

describe('record names and content', () => {
  it('resolves relative names within the zone', () => {
    expect(resolveRecordName('@', 'example.com')).toBe('example.com');
    expect(resolveRecordName('www', 'example.com')).toBe('www.example.com');
    expect(resolveRecordName('www.example.com', 'example.com')).toBe('www.example.com');
    expect(resolveRecordName('_verify', 'example.com')).toBe('_verify.example.com');
  });

  it('validates content by record type', () => {
    expect(() => validateRecord({ type: 'A', name: '@', content: '1.2.3.999' }, 'example.com')).toThrow(/IPv4/);
    expect(() => validateRecord({ type: 'AAAA', name: '@', content: '1.2.3.4' }, 'example.com')).toThrow(/IPv6/);
    expect(() => validateRecord({ type: 'CNAME', name: 'www', content: 'www.example.com' }, 'example.com')).toThrow(
      /itself/,
    );
    expect(() => validateRecord({ type: 'MX', name: '@', content: 'mx.example.com' }, 'example.com')).toThrow(
      /priority/,
    );
    expect(() => validateRecord({ type: 'TXT', name: '@', content: 'x', proxied: true }, 'example.com')).toThrow(
      /proxied/,
    );
    expect(() => validateRecord({ type: 'A', name: '@', content: '1.2.3.4', ttl: 5 }, 'example.com')).toThrow(/ttl/);
    expect(() => validateRecord({ type: 'CAA', name: '@', content: 'bad' }, 'example.com')).toThrow(/CAA/);
    expect(
      validateRecord({ type: 'CNAME', name: 'www', content: 'My-Worker.Example.workers.dev.' }, 'example.com'),
    ).toEqual({
      name: 'www.example.com',
      content: 'my-worker.example.workers.dev',
    });
    expect(validateRecord({ type: 'MX', name: '@', content: 'mx.example.net', priority: 10 }, 'example.com').name).toBe(
      'example.com',
    );
  });

  it('recognizes IPv6 addresses', () => {
    expect(isIPv6('100::')).toBe(true);
    expect(isIPv6('2001:db8::1')).toBe(true);
    expect(isIPv6('example.com')).toBe(false);
  });
});

describe('misc helpers', () => {
  it('normalizes keywords and TLDs', () => {
    expect(normalizeKeyword('My Property App')).toBe('mypropertyapp');
    expect(normalizeTld('.COM')).toBe('com');
    expect(() => normalizeTld('.')).toThrow(ValidationError);
  });
  it('compares nameserver sets', () => {
    expect(
      sameNameservers(['A.ns.cloudflare.com.', 'b.ns.cloudflare.com'], ['b.ns.cloudflare.com', 'a.ns.cloudflare.com']),
    ).toBe(true);
    expect(sameNameservers(['a.ns.cloudflare.com'], ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'])).toBe(false);
  });
  it('validates and matches route patterns', () => {
    expect(validateRoutePattern('Example.com/*')).toBe('example.com/*');
    expect(validateRoutePattern('*/*')).toBe('*/*');
    expect(() => validateRoutePattern('example.com')).toThrow(/path/);
    expect(routeMatchesHostname('*/*', 'a.com')).toBe(true);
    expect(routeMatchesHostname('*.example.com/*', 'app.example.com')).toBe(true);
    expect(routeMatchesHostname('*.example.com/*', 'example.com')).toBe(false);
    expect(routeMatchesHostname('*example.com/*', 'example.com')).toBe(true);
    expect(routeMatchesHostname('example.com/*', 'www.example.com')).toBe(false);
  });
  it('matches certificate hosts including single-level wildcards', () => {
    expect(certificateCovers('*.example.com', 'www.example.com')).toBe(true);
    expect(certificateCovers('*.example.com', 'a.b.example.com')).toBe(false);
    expect(certificateCovers('*.example.com', 'example.com')).toBe(false);
    expect(certificateCovers('example.com', 'example.com')).toBe(true);
  });
});
