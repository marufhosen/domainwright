# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting ("Report a vulnerability" under the repository's Security tab). Include the affected version, a description and, if possible, a minimal reproduction. Never include real API tokens in a report.

## Supported versions

Security fixes are released for the latest minor version.

## Design commitments

- Credentials are supplied by the consuming application, held only in memory and never logged, returned or included in errors.
- Log fields pass through redaction before they reach any logger.
- Purchases require an explicit spending limit and are never retried automatically.
- Destructive operations (deleting records, zones, routes or custom domains, changing nameservers) require explicit confirmation.
- Domainwright only removes resources it created and tagged for the requesting tenant.
- The package has no runtime dependencies.
