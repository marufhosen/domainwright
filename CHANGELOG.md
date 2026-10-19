# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `verify({ checks })` now runs the prerequisites of the requested checks (for example `zone` for `routing`, `certificate` and `dns-resolution` for `https`) instead of reporting them `blocked`, so a restricted verification can pass. Failed or errored prerequisites are included in the report ([#3](https://github.com/marufhosen/domain-pilot/issues/3)).
- A registrar lookup that throws (bad credentials, outage, rate limit) no longer turns the verification report into `error`: the informational `registration` check reports `error` with `required: false` and readiness is decided by the other checks ([#5](https://github.com/marufhosen/domain-pilot/issues/5)).

## [0.1.0] - Unreleased

Initial version.

### Added

- `DomainPilot` client with independent modules and runtime-neutral HTTP (native `fetch`, timeouts, retries with backoff and jitter, cancellation, redacted logging).
- Domain search and availability checks with confirmed/unknown results and registrar suggestions.
- Domain registration with spending limits, premium opt-in, idempotency keys, no automatic retries and `PURCHASE_OUTCOME_UNKNOWN` handling; renewal, registration details and nameserver updates.
- name.com Core API registrar adapter (production and sandbox) and the `RegistrarAdapter` interface.
- Cloudflare zones (create or reuse, nameservers, activation), DNS records (idempotent create, conflict detection, managed-record markers), Workers Custom Domains, Workers Routes, Cloudflare for SaaS custom hostnames and certificate status.
- Tenant-bound ownership challenges.
- Readiness verification: registration, nameservers, zone activation, ownership, DNS records, routing, certificates, public DNS resolution and HTTPS reachability.
- `setupCustomDomain` (resumable, dry run, checkpoints), `getStatus` and `removeCustomDomain` (dry run, only managed resources) workflows.
- Mocked unit and integration tests, opt-in sandbox tests and a Workers runtime smoke test.
- Documentation, CI and release workflows.
