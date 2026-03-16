# Workspace Guard

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/ToppyMicroServices/workspace-guard/badge)](https://securityscorecards.dev/viewer/?uri=github.com/ToppyMicroServices/workspace-guard)
[![OpenSSF Best Practices](https://img.shields.io/badge/OpenSSF%20Best%20Practices-pending-lightgrey)](https://www.bestpractices.dev/)

Prevent accidental home-directory opens in VS Code and review risky `.github` automation before trusting a repository.

Privacy-first and offline-first by default: installing and using the extension does not send telemetry, phone home, or require remote access. Only the optional `--resolve-external-workflows` scan mode fetches external workflow files.

## Quick Start

1. Install Workspace Guard in VS Code.
2. Leave the default `Redirect` mode on, or change it from the `WG:` status bar control.
3. If you want to inspect a repository before trusting it, run `workspace-guard-scan` in that repository.

## Optional CLI

```bash
npx homeguard-code ~
npx workspace-guard-scan .
```

Use `homeguard-code` if you want the `code` command to check risky paths before opening VS Code. Use `workspace-guard-scan` if you want a quick safety review of a repository's `.github` automation before you trust it.

If you want the scanner to inspect external reusable workflows as well, add `--resolve-external-workflows`. That mode is opt-in because it fetches the referenced workflow files.

Disclaimer: Workspace Guard reduces common VS Code workspace and repository-trust mistakes, but it is not a sandbox, malware scanner, or guarantee against all unsafe repositories, extensions, or user actions.

© 2026 ToppyMicroServices OÜ — Registry code 16551297 — Tallinn, Estonia.
