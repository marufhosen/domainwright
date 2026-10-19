import { describe, expect, it } from 'vitest';
import { ConfigurationError, DomainPilot, redact } from '../../src/index.js';
import { createTestEnv } from '../fakes/env.js';

describe('credential handling', () => {
  it('redacts sensitive keys in log fields', () => {
    expect(redact({ apiToken: 'x', nested: { password: 'p', email: 'e@x.com', domain: 'example.com' } })).toEqual({
      apiToken: '[REDACTED]',
      nested: { password: '[REDACTED]', email: '[REDACTED]', domain: 'example.com' },
    });
  });

  it('never includes tokens in errors or logs', async () => {
    const env = createTestEnv();
    const lines: string[] = [];
    const logger = {
      debug: (m: string, f?: object) => lines.push(m + JSON.stringify(f)),
      info: (m: string, f?: object) => lines.push(m + JSON.stringify(f)),
      warn: (m: string, f?: object) => lines.push(m + JSON.stringify(f)),
      error: (m: string, f?: object) => lines.push(m + JSON.stringify(f)),
    };
    const client = env.client({
      cloudflare: { apiToken: 'wrong-token-but-long-enough-xx', accountId: 'a'.repeat(32) },
      logger,
    });
    const error = await client.cloudflare.zones.find('example.com').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED', provider: 'cloudflare', status: 401 });
    const serialized = JSON.stringify(error) + (error as Error).message + lines.join('\n');
    expect(serialized).not.toContain('wrong-token-but-long-enough-xx');
    expect(serialized).not.toContain(env.namecom.token);
  });

  it('validates configuration without network calls', () => {
    const env = createTestEnv();
    expect(() => new DomainPilot({})).toThrow(ConfigurationError);
    expect(() => new DomainPilot({ cloudflare: { apiToken: 'short', accountId: 'a'.repeat(32) } })).toThrow(/apiToken/);
    expect(() => new DomainPilot({ cloudflare: { apiToken: 'x'.repeat(40), accountId: 'nope' } })).toThrow(/accountId/);
    expect(
      () =>
        new DomainPilot({
          registrar: { provider: 'namecom', username: 'me', apiToken: 'token1234', environment: 'sandbox' },
        }),
    ).toThrow(/-test/);
    expect(
      () =>
        new DomainPilot({
          registrar: { provider: 'namecom', username: 'me-test', apiToken: 'token1234', environment: 'production' },
        }),
    ).toThrow(/production/);
    expect(
      () =>
        new DomainPilot({
          cloudflare: { apiToken: 'x'.repeat(40), accountId: 'a'.repeat(32) },
          ownership: { secret: 'short' },
        }),
    ).toThrow(/secret/);
    env.client();
    expect(env.requests).toHaveLength(0);
  });

  it('throws a configuration error when an unconfigured module is used', () => {
    const client = new DomainPilot({ cloudflare: { apiToken: 'x'.repeat(40), accountId: 'a'.repeat(32) } });
    expect(() => client.registrar).toThrow(ConfigurationError);
    expect(() => client.ownership).toThrow(ConfigurationError);
  });

  it('verifies tokens and reports access', async () => {
    const env = createTestEnv();
    const client = env.client();
    await expect(client.cloudflare.verifyToken()).resolves.toEqual({ active: true, status: 'active' });
    const report = await client.cloudflare.checkAccess();
    expect(report.tokenActive).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });
});
