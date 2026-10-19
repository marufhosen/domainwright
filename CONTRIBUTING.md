# Contributing

## Setup

```sh
npm ci
npm run build
npm test
```

Node.js 20 or later is required.

## Checks

Pull requests must pass the same checks CI runs:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:workers
npm run check:package
```

`npm run format` fixes formatting.

## Guidelines

- **Runtime-neutral source.** `src/` uses only Web APIs available in Node.js 20+ and Cloudflare Workers. Lint rules forbid `node:` imports, `Buffer` and `process` there.
- **No runtime dependencies** unless there is no reasonable alternative; discuss first in an issue.
- **Mocked tests for every provider call.** Extend the fakes in `test/fakes` rather than mocking functions. Never add tests that call real providers outside `test/sandbox`.
- **Never purchase or delete in tests** outside the opt-in sandbox suite.
- **Safety first.** Purchases need spending limits and must not be retried; destructive operations need `confirm: true`; only resources Domainwright created may be removed.
- **No secrets in logs, errors or state.** Add a test in `test/unit/security.test.ts` when you add a new credential or log field.
- **Document only what is implemented**, in the same pull request, and add an entry under `[Unreleased]` in `CHANGELOG.md`.
- **Provider facts need a source.** Link the provider documentation for new endpoints, permissions or error codes in the pull request description.

## Adding a registrar adapter

See [docs/registrars.md](docs/registrars.md#writing-an-adapter). Put the adapter in `src/registrars/<provider>/`, add a fake in `test/fakes`, unit tests for every capability it declares, and an opt-in sandbox test if the provider has a sandbox.

## Releasing

Releases are published to npm by `.github/workflows/release.yml` when a GitHub release is published. Only maintainers create releases.

### First release (one time)

npm trusted publishing is configured in the package's settings on npmjs.com, which exist only after the package has been published once. The first version is therefore published with a short-lived token; every later release uses trusted publishing.

1. **Make the repository public.** npm only generates provenance for public repositories, and the release workflow always publishes with provenance.
2. **Prepare the npm account.** Sign in to [npmjs.com](https://www.npmjs.com) and enable two-factor authentication.
3. **Create a temporary token.** In npm, go to _Access Tokens → Generate New Token → Granular Access Token_, with _Read and write_ permission for packages and a short expiry. Add it to the GitHub repository as the secret `NPM_TOKEN` (_Settings → Secrets and variables → Actions_).
4. **Protect the release job (recommended).** Under _Settings → Environments_, create an environment named `npm` and add yourself as a required reviewer. Each publish then waits for your approval. Without this, GitHub creates an unprotected `npm` environment on the first run.
5. **Release `0.1.0`.** Follow _Each release_ below (the version is already `0.1.0`).
6. **Switch to trusted publishing.** On npmjs.com, open the package's _Settings → Trusted publishing_ and add GitHub Actions with owner `marufhosen`, repository `domainwright`, workflow `release.yml` and environment `npm`. Then set _Publishing access_ to _Require two-factor authentication and disallow tokens_, delete the `NPM_TOKEN` secret and revoke the token.

### Each release

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under the new version and date.
2. Update `version` in `package.json` (`npm version <major|minor|patch> --no-git-tag-version`) following semantic versioning. Before 1.0.0, breaking changes bump the minor version.
3. Merge to `main`, then create a GitHub release with tag `v<version>`. The workflow checks that the tag matches `package.json`, runs every check and publishes.
