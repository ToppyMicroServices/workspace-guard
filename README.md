# Workspace Guard

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/ToppyMicroServices/workspace-guard/badge)](https://securityscorecards.dev/viewer/?uri=github.com/ToppyMicroServices/workspace-guard)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12215/badge)](https://www.bestpractices.dev/projects/12215)

Prevent accidental home-directory opens in VS Code and review risky repository trust surfaces before trusting a repository.

Privacy-first and offline-first by default: installing and using the extension does not send telemetry, phone home, or require remote access. Only the optional `--resolve-external-workflows` scan mode fetches external workflow files.

## Quick Start

1. Install Workspace Guard in VS Code.
2. Leave the default `Redirect` mode on, or change it from the `WG:` status bar control.
3. Open the `Workspace Guard Review` section in Explorer for a lightweight repository review tree inside VS Code, then click any finding for remediation guidance.
4. Use the filter and export actions in that view if you want to focus on one severity or share the review as JSON or Markdown.
5. Run `Workspace Guard: Review Repository Trust Surfaces` from the Command Palette if you want the same review in the output panel.
6. If you want to inspect a repository from the terminal, run `workspace-guard-scan` in that repository.

## Optional CLI

```bash
npx homeguard-code ~
npx workspace-guard-scan .
```

Use `homeguard-code` if you want the `code` command to check risky paths before opening VS Code. Use `workspace-guard-scan` if you want a quick safety review of a repository's `.github`, `.vscode`, multi-root `.code-workspace`, `.devcontainer`, extension recommendation, AI/MCP, and LaTeX trust surfaces before you trust it.

If you want the scanner to inspect external reusable workflows as well, add `--resolve-external-workflows`. That mode is opt-in because it fetches the referenced workflow files.

Project docs: [External interface](https://github.com/ToppyMicroServices/workspace-guard/blob/main/docs/external-interface.md) · [Contributing](https://github.com/ToppyMicroServices/workspace-guard/blob/main/CONTRIBUTING.md) · [Support](https://github.com/ToppyMicroServices/workspace-guard/blob/main/SUPPORT.md) · [Security](https://github.com/ToppyMicroServices/workspace-guard/blob/main/.github/SECURITY.md) · [OpenSSF readiness](https://github.com/ToppyMicroServices/workspace-guard/blob/main/docs/openssf-best-practices.md)

Disclaimer: Workspace Guard reduces common VS Code workspace and repository-trust mistakes, but it is not a sandbox, malware scanner, or guarantee against all unsafe repositories, extensions, or user actions.

© 2026 ToppyMicroServices OÜ — Registry code 16551297 — Tallinn, Estonia.
