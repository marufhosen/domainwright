// Core
export { Domainwright } from './core/client.js';
export type { WorkflowsModule } from './core/client.js';
export type { DomainwrightConfig } from './core/config.js';
export * from './core/errors.js';
export { HttpClient } from './core/http.js';
export type { FetchLike, HttpOptions } from './core/http.js';
export { createConsoleLogger, noopLogger, redact } from './core/logger.js';
export type { LogFields, LogLevel, Logger } from './core/logger.js';
export { resolveWorkerService } from './core/types.js';
export type {
  CheckId,
  CheckResult,
  CheckStatus,
  DomainLifecycleState,
  OutstandingAction,
  RequestOptions,
  RoutingStrategy,
  WorkerTarget,
} from './core/types.js';

// Modules
export * from './cloudflare/index.js';
export * from './registrars/index.js';
export * from './verification/index.js';
export * from './workflows/index.js';
export { DomainsModule, DomainRegistration, DomainSearch } from './domains/index.js';
export type {
  PurchaseDomainInput,
  PurchaseDomainResult,
  RenewDomainInput,
  SearchDomainsInput,
  SearchDomainsResult,
  SearchResult,
  SetNameserversInput,
  SpendingLimit,
} from './domains/index.js';

// Utilities
export { normalizeHostname, isWithinZone } from './utils/validation.js';
export { poll } from './utils/polling.js';
export type { PollOptions, PollResult } from './utils/polling.js';
export type { RetryPolicy } from './utils/retry.js';
