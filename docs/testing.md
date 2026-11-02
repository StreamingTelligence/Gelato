# Testing and pull request policy

Gelato's required pull request checks protect the public device and model
protocols, Controller behavior, and Node SDKs. They do not require service
credentials, external APIs, or physical devices.

## Local commands

```sh
npm ci
npm run test:unit
npm run test:contract
npm run test:integration
npm run test:package
npm run test:coverage
npm run check:test-types
npm run ci
```

The coverage gate applies only to the explicitly listed core modules in
`vitest.config.ts`: 80% lines/statements/functions and 70% branches. Do not
expand the list merely to increase a repository-wide percentage; add a
behavioral test when a module becomes part of the supported public path.
The package smoke test checks the publishable file list and imports the built
public ESM entry points using an isolated temporary npm cache.

## One-time GitHub repository setting

After the workflow has run once, add a branch rule or repository ruleset for
`main` that requires a pull request and the single `ci-required` status check.
Do not require `Node build and tests` separately: `ci-required` is the stable
summary check and fails whenever that job is skipped, cancelled, or fails.
Disallow bypass for ordinary maintainers if the repository intends this check
to be a hard merge gate.

## Maintenance rules

- A confirmed bug fix should include a failing regression test or invalid
  protocol fixture before the fix is merged.
- Schema or protocol-specification changes require review of the maintained
  valid and invalid fixtures and an intentional update to
  `contract-revision.json`.
- Do not add automatic retries to hide an intermittent test. Open an issue,
  record the failure evidence, and fix or explicitly quarantine it within two
  iterations.
- The pull request author owns the tests. A second maintainer reviews behavior,
  compatibility, and security boundaries. Rotate weekly responsibility for
  new issue and failed-CI triage.
- `ci-required` is the single required branch-protection check. Dependency
  audit output is currently evidence-only; make high/critical findings
  blocking after the existing findings are resolved.

## Manual device release record

Physical-device validation remains a release check. Record the following in
the release issue or attached test report:

```text
commit/tag:
test date and owner:
device model, OS, and app/SDK version:
Controller version and network mode:
pairing result and duration:
reconnect result and duration:
command, cancellation, and media-upload results:
command latency observations:
media frames, bytes, disconnects, and recovery:
location of redacted Controller and device logs:
```

Never attach pairing codes, access tokens, device credentials, account data,
or unredacted user media to a public issue.
