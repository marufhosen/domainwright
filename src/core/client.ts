import { CloudflareClient } from '../cloudflare/client.js';
import { DomainsModule } from '../domains/index.js';
import { DomainRegistration } from '../domains/registration.js';
import { DomainSearch } from '../domains/search.js';
import { OwnershipModule } from '../ownership/ownership.js';
import { NameComRegistrar } from '../registrars/namecom/adapter.js';
import type { RegistrarAdapter } from '../registrars/types.js';
import { DohResolver, type DnsResolver } from '../verification/resolver.js';
import type { VerificationReport, VerifyDomainInput } from '../verification/types.js';
import { DomainVerifier } from '../verification/verifier.js';
import type { WorkflowDeps } from '../workflows/context.js';
import { removeCustomDomain } from '../workflows/remove-custom-domain.js';
import { setupCustomDomain } from '../workflows/setup-custom-domain.js';
import { getDomainStatus } from '../workflows/status.js';
import type {
  DomainStatusResult,
  RemoveCustomDomainInput,
  RemoveCustomDomainResult,
  SetupCustomDomainInput,
  SetupCustomDomainResult,
} from '../workflows/types.js';
import { type DomainPilotConfig, isRegistrarAdapter, validateConfig } from './config.js';
import { ConfigurationError } from './errors.js';
import { type FetchLike, HttpClient } from './http.js';
import { type Logger, createSafeLogger } from './logger.js';

export interface WorkflowsModule {
  /** Complete, resumable onboarding of a tenant domain. */
  setupCustomDomain(input: SetupCustomDomainInput): Promise<SetupCustomDomainResult>;
  /** Inspect the current lifecycle state and checks without changing anything. */
  getStatus(input: VerifyDomainInput): Promise<DomainStatusResult>;
  /** Disconnect a domain, removing only resources DomainPilot manages. */
  removeCustomDomain(input: RemoveCustomDomainInput): Promise<RemoveCustomDomainResult>;
}

/**
 * Main entry point. Construction validates configuration but performs no network calls.
 * Modules whose provider is not configured throw `CONFIGURATION_ERROR` when used.
 */
export class DomainPilot {
  readonly domains: DomainsModule;
  readonly workflows: WorkflowsModule;
  private readonly logger: Logger;
  private readonly http: HttpClient;
  private readonly cloudflareClient: CloudflareClient | undefined;
  private readonly registrarAdapter: RegistrarAdapter | undefined;
  private readonly ownershipModule: OwnershipModule | undefined;
  private readonly resolver: DnsResolver;
  private readonly probeFetch: FetchLike;
  private verifierInstance: DomainVerifier | undefined;

  constructor(config: DomainPilotConfig) {
    validateConfig(config);
    this.logger = createSafeLogger(config.logger);
    this.http = new HttpClient(config.http, this.logger);
    this.cloudflareClient = config.cloudflare
      ? new CloudflareClient(config.cloudflare, { http: this.http, logger: this.logger })
      : undefined;
    if (config.registrar) {
      this.registrarAdapter = isRegistrarAdapter(config.registrar)
        ? config.registrar
        : new NameComRegistrar(config.registrar, { http: this.http, logger: this.logger });
    }
    this.resolver = config.dns?.resolver ?? new DohResolver(this.http, config.dns?.dohUrl);
    this.ownershipModule = config.ownership ? new OwnershipModule(config.ownership, this.resolver) : undefined;
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    this.probeFetch = config.probeFetch ?? config.http?.fetch ?? ((input, init) => globalFetch!(input, init));

    const registration = (): DomainRegistration => new DomainRegistration(() => this.registrar, this.logger);
    const search = (): DomainSearch => new DomainSearch(() => this.registrar);
    this.domains = new DomainsModule(search, registration, (input) => this.verifier.verify(input));
    this.workflows = {
      setupCustomDomain: (input) => setupCustomDomain(this.workflowDeps(), input),
      getStatus: (input) => getDomainStatus(this.workflowDeps(), input),
      removeCustomDomain: (input) => removeCustomDomain(this.workflowDeps(), input),
    };
  }

  /** Cloudflare zones, DNS, Workers routing, custom hostnames and certificates. */
  get cloudflare(): CloudflareClient {
    if (!this.cloudflareClient)
      throw new ConfigurationError('Cloudflare is not configured; pass cloudflare: { apiToken, accountId }');
    return this.cloudflareClient;
  }

  /** The configured registrar adapter. */
  get registrar(): RegistrarAdapter {
    if (!this.registrarAdapter)
      throw new ConfigurationError('No registrar is configured; pass registrar: { provider: "namecom", ... }');
    return this.registrarAdapter;
  }

  /** Tenant-bound ownership challenges and markers. */
  get ownership(): OwnershipModule {
    if (!this.ownershipModule) throw new ConfigurationError('Ownership is not configured; pass ownership: { secret }');
    return this.ownershipModule;
  }

  /** Readiness verification (also available as `domains.verify`). */
  get verifier(): DomainVerifier {
    this.verifierInstance ??= new DomainVerifier({
      cloudflare: this.cloudflare,
      resolver: this.resolver,
      fetch: this.probeFetch,
      registrar: this.registrarAdapter,
      ownership: this.ownershipModule,
    });
    return this.verifierInstance;
  }

  verify(input: VerifyDomainInput): Promise<VerificationReport> {
    return this.verifier.verify(input);
  }

  private workflowDeps(): WorkflowDeps {
    return {
      cloudflare: this.cloudflare,
      verifier: this.verifier,
      logger: this.logger,
      registrar: this.registrarAdapter,
      registration: this.registrarAdapter ? new DomainRegistration(() => this.registrar, this.logger) : undefined,
      ownership: this.ownershipModule,
    };
  }
}
