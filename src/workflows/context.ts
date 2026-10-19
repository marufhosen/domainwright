import type { CloudflareClient } from '../cloudflare/client.js';
import type { Logger } from '../core/logger.js';
import type { DomainLifecycleState } from '../core/types.js';
import type { DomainRegistration } from '../domains/registration.js';
import type { OwnershipModule } from '../ownership/ownership.js';
import type { RegistrarAdapter } from '../registrars/types.js';
import type { DomainVerifier } from '../verification/verifier.js';
import type { HostnameSelection, StepRecord } from './types.js';
import { ValidationError } from '../core/errors.js';
import { normalizeHostname, unique } from '../utils/validation.js';

export interface WorkflowDeps {
  cloudflare: CloudflareClient;
  verifier: DomainVerifier;
  logger: Logger;
  registrar?: RegistrarAdapter | undefined;
  registration?: DomainRegistration | undefined;
  ownership?: OwnershipModule | undefined;
}

export const now = (): string => new Date().toISOString();

export function selectHostnames(domain: string, selection: HostnameSelection = {}): string[] {
  const hostnames: string[] = [];
  if (selection.root ?? true) hostnames.push(domain);
  if (selection.www) hostnames.push(`www.${domain}`);
  for (const label of selection.subdomains ?? []) {
    hostnames.push(normalizeHostname(`${label}.${domain}`, { field: 'dns.subdomains' }));
  }
  if (!hostnames.length)
    throw new ValidationError('Select at least one hostname (dns.root, dns.www or dns.subdomains)', { field: 'dns' });
  return unique(hostnames);
}

/** Derive the domain lifecycle from step outcomes. */
export function deriveLifecycle(steps: StepRecord[]): DomainLifecycleState {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const failed = steps.find((s) => s.status === 'failed');
  // An unknown purchase outcome is resolved by resuming (registrar lookup / idempotent replay).
  if (failed?.id === 'registration' && failed.error?.code === 'PURCHASE_OUTCOME_UNKNOWN') return 'registering';
  if (failed && !failed.error?.retryable) return 'failed';
  if (failed?.id === 'registration' || byId.get('registration')?.status === 'waiting') return 'registering';
  const verification = byId.get('verification');
  if (verification?.status === 'succeeded') return 'active';
  if (!failed && (verification?.status === 'waiting' || byId.get('routing')?.status === 'succeeded'))
    return 'verifying';
  const started = steps.some(
    (s) => s.id !== 'validate' && (s.status === 'succeeded' || s.status === 'waiting' || s.status === 'failed'),
  );
  return started ? 'configuring' : 'pending';
}
