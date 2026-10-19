import { UnsupportedOperationError } from '../core/errors.js';
import type { RegistrarAdapter, RegistrarCapabilities } from '../registrars/types.js';

const METHOD: Record<keyof RegistrarCapabilities, keyof RegistrarAdapter | undefined> = {
  checkAvailability: 'checkAvailability',
  suggestions: 'suggest',
  pricing: 'getPricing',
  register: 'register',
  idempotentRegistration: undefined,
  renew: 'renew',
  getDomain: 'getDomain',
  setNameservers: 'setNameservers',
};

export function supports(registrar: RegistrarAdapter, capability: keyof RegistrarCapabilities): boolean {
  const method = METHOD[capability];
  return registrar.capabilities[capability] && (method === undefined || typeof registrar[method] === 'function');
}

export function requireCapability(registrar: RegistrarAdapter, capability: keyof RegistrarCapabilities): void {
  if (!supports(registrar, capability)) {
    throw new UnsupportedOperationError(`${registrar.displayName} does not support ${capability}`, {
      registrar: registrar.id,
      capability,
    });
  }
}
