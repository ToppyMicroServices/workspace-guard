# OpenSSF Best Practices Readiness

This repository is prepared so the OpenSSF Best Practices application can point to concrete project documents and workflows.

## Repository References

- Security policy: [`/.github/SECURITY.md`](../.github/SECURITY.md)
- Contribution guide: [`/CONTRIBUTING.md`](../CONTRIBUTING.md)
- Code of conduct: [`/CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md)
- Support guide: [`/SUPPORT.md`](../SUPPORT.md)
- Governance: [`/GOVERNANCE.md`](../GOVERNANCE.md)
- CI workflows: [`/.github/workflows`](../.github/workflows)
- Dependency updates: [`/.github/dependabot.yml`](../.github/dependabot.yml)
- Scorecard workflow: [`/.github/workflows/scorecard.yml`](../.github/workflows/scorecard.yml)

## Current Technical Controls

- Protected `main` branch with required checks and review requirements
- CodeQL analysis
- Scorecard analysis
- Dependabot updates
- Security policy and private vulnerability reporting guidance
- Unit, build, and Extension Development Host smoke tests
- Pinned GitHub Actions in workflows

## Manual Step Still Required

The OpenSSF Best Practices badge itself must be requested through the external service at [bestpractices.dev](https://www.bestpractices.dev/). That enrollment cannot be completed from repository files alone.

When applying, use the repository documents above as the source of truth.
