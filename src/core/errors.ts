/**
 * Error classes and machine-readable error codes.
 *
 * Every error thrown by Domainwright is a `DomainwrightError` (or subclass) with a
 * stable `code`. Error messages and `details` never contain credentials: request
 * headers are never attached, and provider payloads are reduced to their
 * documented `code`/`message` fields.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'ABORTED'
  | 'PROVIDER_ERROR'
  | 'UNSUPPORTED_OPERATION'
  | 'CONFIRMATION_REQUIRED'
  | 'DOMAIN_UNAVAILABLE'
  | 'PURCHASE_NOT_AUTHORIZED'
  | 'PAYMENT_FAILED'
  | 'PURCHASE_FAILED'
  | 'PURCHASE_OUTCOME_UNKNOWN'
  | 'TENANT_CONFLICT'
  | 'WORKFLOW_STATE_MISMATCH';

export interface ProviderErrorDetail {
  code?: string | number;
  message: string;
}

export interface DomainwrightErrorOptions {
  /** Whether repeating the same call later may succeed. */
  retryable?: boolean;
  /** Provider that produced the error, e.g. `cloudflare` or `namecom`. */
  provider?: string;
  /** HTTP status returned by the provider, when applicable. */
  status?: number;
  /** Errors reported by the provider (code and message only). */
  providerErrors?: ProviderErrorDetail[];
  /** Additional non-sensitive structured context. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class DomainwrightError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly provider: string | undefined;
  readonly status: number | undefined;
  readonly providerErrors: ProviderErrorDetail[];
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: DomainwrightErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainwrightError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.provider = options.provider;
    this.status = options.status;
    this.providerErrors = options.providerErrors ?? [];
    this.details = options.details ?? {};
  }

  /** A JSON-safe representation, suitable for logs and persisted workflow state. */
  toJSON(): SerializedError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.providerErrors.length ? { providerErrors: this.providerErrors } : {}),
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}

export interface SerializedError {
  name: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
  provider?: string;
  status?: number;
  providerErrors?: ProviderErrorDetail[];
  details?: Record<string, unknown>;
}

/** Invalid input supplied by the caller. Never retryable. */
export class ValidationError extends DomainwrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, details ? { details } : {});
    this.name = 'ValidationError';
  }
}

/** Missing or inconsistent SDK configuration. */
export class ConfigurationError extends DomainwrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFIGURATION_ERROR', message, details ? { details } : {});
    this.name = 'ConfigurationError';
  }
}

/** An error returned by, or while talking to, an external provider. */
export class ProviderError extends DomainwrightError {
  constructor(code: ErrorCode, message: string, options: DomainwrightErrorOptions = {}) {
    super(code, message, options);
    this.name = 'ProviderError';
  }
}

/** The requested operation is not supported by the configured provider. */
export class UnsupportedOperationError extends DomainwrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('UNSUPPORTED_OPERATION', message, details ? { details } : {});
    this.name = 'UnsupportedOperationError';
  }
}

/** A destructive or billable operation was attempted without explicit confirmation. */
export class ConfirmationRequiredError extends DomainwrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFIRMATION_REQUIRED', message, details ? { details } : {});
    this.name = 'ConfirmationRequiredError';
  }
}

/** A resource is bound to a different tenant or Worker than the caller expects. */
export class TenantConflictError extends DomainwrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('TENANT_CONFLICT', message, details ? { details } : {});
    this.name = 'TenantConflictError';
  }
}

/** Purchase-related failures (not authorized, payment failed, unknown outcome, ...). */
export class PurchaseError extends DomainwrightError {
  constructor(
    code: Extract<
      ErrorCode,
      | 'PURCHASE_NOT_AUTHORIZED'
      | 'PAYMENT_FAILED'
      | 'PURCHASE_FAILED'
      | 'PURCHASE_OUTCOME_UNKNOWN'
      | 'DOMAIN_UNAVAILABLE'
    >,
    message: string,
    options: DomainwrightErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = 'PurchaseError';
  }
}

export function isDomainwrightError(error: unknown, code?: ErrorCode): error is DomainwrightError {
  return error instanceof DomainwrightError && (code === undefined || error.code === code);
}

/** Convert any thrown value into a JSON-safe error record without leaking unknown payloads. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof DomainwrightError) return error.toJSON();
  if (error instanceof Error) {
    return { name: error.name, code: 'PROVIDER_ERROR', message: error.message, retryable: false };
  }
  return { name: 'Error', code: 'PROVIDER_ERROR', message: 'Unknown error', retryable: false };
}
