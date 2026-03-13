# Workspace Guard

Prevent accidental home-directory opens in VS Code and review risky `.github` automation before trusting a repository.

Privacy-first and offline-first by default: installing and using the extension does not send telemetry, phone home, or require remote access. Only the optional `--resolve-external-workflows` scan mode fetches external workflow files.

## Quick Start

1. Install Workspace Guard in VS Code.
2. Leave the default `Redirect` mode on, or change it from the `WG:` status bar control.
3. If you want to inspect a repository's automation risk, run `workspace-guard-scan` against that repository.

## CLI Usage

```bash
npx homeguard-code ~
npx homeguard-code .
npx homeguard-code -- ~/work/projectA ~
```

Core CLI behaviors:

- Safe targets pass through unchanged
- Home-directory targets can warn, redirect, block, or audit
- High-risk folders warn without rewriting the target
- Redirect mode creates the escape folder before spawning VS Code

## GitHub Metadata Scan

Use the scanner to review high-risk repository metadata before enabling Actions or trusting repository automation:

```bash
npx workspace-guard-scan .
npx workspace-guard-scan --resolve-external-workflows .
```

The scanner is meant to answer a simple question before you trust a repository: "Can this repo run something dangerous, publish something, or trick a maintainer into doing the wrong thing?"

It currently looks for:

- GitHub Actions that can execute dangerous code, publish with too much power, or trust untrusted pull request input
- Indirect execution paths that are easy to miss, such as reusable workflows, container-based actions, and values that flow into shell execution
- Repository settings that weaken dependency safety or review flow, such as risky Dependabot options and overly broad `CODEOWNERS`
- Issue and pull request templates that push contributors toward unsafe commands or secret disclosure

If you want the scanner to inspect external reusable workflows as well, add `--resolve-external-workflows`. That mode is opt-in because it performs a network fetch for the referenced workflow files.

© 2026 ToppyMicroServices OÜ — Registry code 16551297 — Tallinn, Estonia.
