export { setupCustomDomain } from './setup-custom-domain.js';
export { removeCustomDomain } from './remove-custom-domain.js';
export { getDomainStatus, lifecycleFromVerification } from './status.js';
export { deriveLifecycle, selectHostnames } from './context.js';
export type { WorkflowDeps } from './context.js';
export type {
  DomainStatusResult,
  HostnameSelection,
  PlannedChange,
  RegistrationState,
  RemovalStepId,
  RemoveCustomDomainInput,
  RemoveCustomDomainResult,
  SetupCustomDomainInput,
  SetupCustomDomainResult,
  SetupStepId,
  SetupWorkflowState,
  StepRecord,
  StepStatus,
  WorkflowResources,
} from './types.js';
