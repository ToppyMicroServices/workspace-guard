# External Interface Reference

This document describes the external interface of Workspace Guard, including the supported inputs and outputs for the VS Code extension and CLI tools.

## VS Code Extension

### Commands

The extension contributes these user-facing commands through the Command Palette:

- `Workspace Guard: Open Escape Folder`
- `Workspace Guard: Set Protection Mode`
- `Workspace Guard: Remove Home Folders From Workspace`
- `Workspace Guard: Audit Telemetry Settings`
- `Workspace Guard: Apply Privacy Hardening`
- `Workspace Guard: Roll Back Privacy Hardening`
- `Workspace Guard: Assess Workspace Safety`
- `Workspace Guard: Review .github Automation`
- `Workspace Guard: Refresh .github Review`
- `Workspace Guard: Suggest .github Remediation`
- `Workspace Guard: Show .github Finding Details`
- `Workspace Guard: Set .github Review Filter`
- `Workspace Guard: Export .github Review as JSON`
- `Workspace Guard: Export .github Review as Markdown`

### Settings Input

The extension accepts configuration through VS Code settings under the `homeguard.*` namespace.

Key inputs include:

- `homeguard.enable`
- `homeguard.mode`
- `homeguard.escapeFolder`
- `homeguard.enableEphemeralEscape`
- `homeguard.checkOnStartup`
- `homeguard.checkOnWorkspaceFolderAdd`
- `homeguard.allowList`
- `homeguard.highRiskFolders`
- `homeguard.verbose`
- `homeguard.privacy.*`
- `homeguard.githubReview.checkOnStartup`
- `homeguard.safety.*`

### Extension Output

The extension produces output through:

- notifications and warnings in VS Code
- the `WG:` status bar control
- the `Workspace Guard Review` Explorer tree
- output panel review summaries
- exported `.github` review reports in JSON or Markdown
- workspace actions such as redirecting to an escape folder or removing risky folders from the workspace

## CLI

Workspace Guard provides two CLI entry points.

### `homeguard-code`

Input:

- a target path or paths passed on the command line, intended as a safer wrapper around the VS Code `code` CLI

Behavior:

- evaluates the requested path
- warns, redirects, blocks, or audits based on the configured policy
- launches the VS Code `code` CLI when allowed

Output:

- terminal messages describing the safety decision
- process exit status indicating success or failure

### `workspace-guard-scan`

Input:

- a repository or workspace path
- optional `--resolve-external-workflows` to fetch referenced reusable workflows for deeper inspection

Behavior:

- scans `.github/workflows/*.yml`, `dependabot.yml`, `CODEOWNERS`, and issue or pull request templates
- evaluates workflow and repository metadata risks

Output:

- terminal review output with findings grouped by severity
- JSON or Markdown content when exported through the extension workflow

## Repository Interface

The project also exposes these public repository interfaces:

- GitHub issues for bug reports and feature requests
- pull requests for proposed changes
- releases for published VSIX artifacts
- security policy for responsible disclosure

Related project references:

- [README](https://github.com/ToppyMicroServices/workspace-guard/blob/main/README.md)
- [Contributing](https://github.com/ToppyMicroServices/workspace-guard/blob/main/CONTRIBUTING.md)
- [Security Policy](https://github.com/ToppyMicroServices/workspace-guard/blob/main/.github/SECURITY.md)
