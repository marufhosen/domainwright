export { DomainVerifier } from './verifier.js';
export type { VerifierDeps } from './verifier.js';
export type { CheckError, RoutingSpec, VerificationReport, VerifyDomainInput } from './types.js';
export { DEFAULT_DOH_URL, DohResolver, createDohResolver, decodeTxt } from './resolver.js';
export type { DnsAnswer, DnsResolver, ResolvableType } from './resolver.js';
export { probeHttps } from './reachability.js';
export type { HttpsExpectation, ReachabilityResult } from './reachability.js';
export { OwnershipModule } from '../ownership/ownership.js';
export type { OwnershipChallenge, OwnershipConfig, OwnershipVerificationResult } from '../ownership/ownership.js';
