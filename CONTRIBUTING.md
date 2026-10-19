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
- **Safety first.** Purchases need spending limits and must not be retried; destructive operations need `confirm: true`; only resources DomainPilot created may be removed.
- **No secrets in logs, errors or state.** Add a test in `test/unit/security.test.ts` when you add a new credential or log field.
- **Document only what is implemented**, in the same pull request, and add an entry under `[Unreleased]` in `CHANGELOG.md`.
- **Provider facts need a source.** Link the provider documentation for new endpoints, permissions or error codes in the pull request description.

## Adding a registrar adapter

See [docs/registrars.md](docs/registrars.md#writing-an-adapter). Put the adapter in `src/registrars/<provider>/`, add a fake in `test/fakes`, unit tests for every capability it declares, and an opt-in sandbox test if the provider has a sandbox.

## Releasing

Releases are published to npm by `.github/workflows/release.yml` when a GitHub release is published. Only maintainers create releases.

Before the first release:

1. **Choose the package identity.** Replace the placeholder `@your-scope/domainpilot` in `package.json` (`name`, `repository`, `homepage`, `bugs`) and in the docs and examples:

   ```sh
   grep -rl '@your-scope/domainpilot' --exclude-dir=node_modules --exclude-dir=dist . | xargs sed -i 's#@your-scope/domainpilot#@acme/domains#g'
   grep -rl 'your-org/domainpilot' --exclude-dir=node_modules --exclude-dir=dist . | xargs sed -i 's#your-org/domainpilot#acme/domains#g'
   ```

   (On macOS use `sed -i ''`.)

2. **Authorize publishing.** Either configure npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) for this repository and the `release.yml` workflow, or add an npm automation token as the `NPM_TOKEN` repository secret. The workflow publishes with provenance in both cases.
3. **Protect the release.** Create a `npm` GitHub environment with required reviewers; the publish job runs in it.

Each release:

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under the new version and date.
2. Update `version` in `package.json` (`npm version <major|minor|patch> --no-git-tag-version`) following semantic versioning. Before 1.0.0, breaking changes bump the minor version.
3. Merge to `main`, then create a GitHub release with tag `v<version>`. The workflow checks that the tag matches `package.json`, runs every check and publishes.
