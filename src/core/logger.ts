/**
 * Structured logging without secrets.
 *
 * The SDK never logs request headers or bodies. Fields passed to the logger are
 * run through `redact`, which masks keys that commonly carry credentials or
 * personal registration data.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const SENSITIVE_KEY =
  /(token|secret|password|passwd|authorization|api[-_]?key|apikey|credential|cookie|signature|private|email|phone|fax|address|street|postal|zip|contact|card|payment)/i;

const REDACTED = '[REDACTED]';

/** Return a deep copy of `value` with sensitive keys masked. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[Truncated]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/** Wrap a logger so every call is redacted. Used internally for all SDK logging. */
export function createSafeLogger(logger: Logger | undefined): Logger {
  if (!logger) return noopLogger;
  const wrap =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      try {
        logger[level](message, fields ? (redact(fields) as LogFields) : undefined);
      } catch {
        // A failing logger must never break provider operations.
      }
    };
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
}

/** A minimal console logger for local development. */
export function createConsoleLogger(minLevel: LogLevel = 'info'): Logger {
  const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const enabled = (level: LogLevel): boolean => order.indexOf(level) >= order.indexOf(minLevel);
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (!enabled(level)) return;
    const line = fields ? `${message} ${JSON.stringify(redact(fields))}` : message;
    console[level === 'debug' ? 'log' : level](`[domainwright] ${line}`);
  };
  return {
    debug: (m, f) => {
      emit('debug', m, f);
    },
    info: (m, f) => {
      emit('info', m, f);
    },
    warn: (m, f) => {
      emit('warn', m, f);
    },
    error: (m, f) => {
      emit('error', m, f);
    },
  };
}
