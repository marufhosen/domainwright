import type { DomainLifecycleState } from '../core/types.js';
import type { VerificationReport, VerifyDomainInput } from '../verification/types.js';
import type { WorkflowDeps } from './context.js';
import type { DomainStatusResult } from './types.js';

/** Map a verification report onto the domain lifecycle. */
export function lifecycleFromVerification(report: VerificationReport): DomainLifecycleState {
  if (report.verified) return 'active';
  if (report.summary === 'failed') return 'failed';
  const zone = report.checks.find((c) => c.id === 'zone');
  const routing = report.checks.filter((c) => c.id === 'routing');
  if (zone?.status === 'failed' || routing.some((c) => c.status === 'failed')) return 'configuring';
  return 'verifying';
}

/** Inspect a domain's current state without changing anything. */
export async function getDomainStatus(deps: WorkflowDeps, input: VerifyDomainInput): Promise<DomainStatusResult> {
  const verification = await deps.verifier.verify({ ...input, waitForReady: false });
  return { domain: verification.domain, lifecycle: lifecycleFromVerification(verification), verification };
}
