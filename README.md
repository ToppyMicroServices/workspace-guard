# Workspace Guard

## TL;DR

- Use `homeguard-code` to stop accidental `~` opens in VS Code
- Use `workspace-guard-scan` to review `.github` automation risk before trusting a repo

Why this matters:

- Accidentally opening your home directory in VS Code can expose secrets, dotfiles, cloud credentials, and unrelated personal files to search, edit, Git, and extension activity.
- Risky `.github` files can turn a harmless-looking repository into one that runs dangerous automation, weakens review flow, or pushes maintainers toward unsafe actions.

Workspace Guard is a TypeScript library and CLI for reducing the risk of opening your entire home directory in VS Code. It provides:

- Path-risk evaluation for home and high-risk folders
- A safety wrapper around the VS Code `code` CLI
- A `.github` scanner for GitHub workflow and repository-metadata risks
- Extension-host helpers for workspace detection and guarded actions
- Telemetry hardening helpers with rollback support

Workspace Guard is privacy-first and offline-first by default. Installing and using the library, CLI, and extension does not send telemetry, phone home, or require remote access. The only networked behavior is the scanner's explicit opt-in `--resolve-external-workflows` mode, which fetches referenced reusable workflows so they can be inspected locally.

## Quick Start

1. Install Workspace Guard in VS Code.
2. Leave the default `Redirect` mode on, or change it from the `WG:` status bar control.
3. If you want to inspect a repository's automation risk, run `workspace-guard-scan` against that repository.

## Project Layout

- `src/core/pathPolicy.ts`: path expansion, normalization, `realpath`, and risk classification
- `src/core/escapeFolder.ts`: escape-folder resolution and initialization
- `src/cli/homeguardCode.ts`: CLI planning and `code` process execution
- `src/extension/homeguardExtension.ts`: workspace detection and activation flow
- `src/extension/workspaceSafetyGuard.ts`: action-level guards for save/git/terminal/task/publish
- `src/core/telemetry.ts`: telemetry audit and hardening profile
- `src/core/settingsBackup.ts`: settings backup and rollback

## CLI Usage

`src/cli.ts` currently starts the wrapper in `redirect` mode.

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

- Dangerous GitHub Actions setups, such as privileged PR workflows, broad write permissions, self-hosted runners, risky shell commands, and third-party actions that are not pinned tightly enough
- Hidden or indirect execution paths, such as reusable workflows, `docker://` actions, `secrets: inherit`, scheduled/manual triggers, and untrusted values that flow into `run` steps or execution-related inputs
- Repository automation settings that weaken review or dependency safety, such as risky `dependabot.yml` options and catch-all `CODEOWNERS` rules
- Social-engineering prompts in issue and pull request templates, such as asking contributors to paste secrets or run dangerous commands

If you want the scanner to inspect external reusable workflows as well, add `--resolve-external-workflows`. That mode is opt-in because it performs a network fetch for the referenced workflow files.

## Library Entry Points

The package re-exports the main APIs from `src/index.ts`.

Useful entry points:

- `evaluatePathRisk`
- `scanGithubMetadata`
- `buildCliExecutionPlan`
- `runHomeguardCode`
- `activateHomeguardExtension`
- `createHomeguardCommandHandlers`
- `createWorkspaceSafetyGuard`
- `auditTelemetrySettings`
- `applyTelemetryHardening`

## Security Notes

This codebase does not have a browser/UI layer, so CSS/XSS-style issues are out of scope here.

The main security boundaries are local process execution and filesystem path handling:

- CLI execution uses `child_process.spawn(...)` without `shell: true`, so argument injection through shell parsing is avoided.
- Path comparisons go through normalization and `realpath`, which prevents simple symlink-based bypasses when checking whether a workspace resolves to the home directory or a high-risk folder.
- Ephemeral escape-folder names are sanitized before joining with `tmpdir()`, which avoids invalid filenames and blocks traversal-like suffixes from escaping the temp directory.
- Telemetry rollback now restores keys that were absent before hardening by explicitly unsetting them during rollback.

Trusted-input assumptions:

- `escapeFolder`, settings profiles, and extension host callbacks are treated as trusted local configuration.
- The library is designed for local editor safety, not sandboxing an untrusted caller.

## Memory and Lifecycle Notes

- `activateHomeguardExtension()` registers exactly one workspace-folder subscription and returns a `dispose()` function to release it.
- There are no background timers, caches, or long-lived queues in the current implementation.
- Logging writes directly to the provided output channel and does not retain historical buffers in memory.

Based on the current code, there is no obvious memory leak path as long as extension consumers call `dispose()` on activation results.

## Current Limitations

- Risk heuristics are intentionally conservative and regex-based for commands such as `rm -rf`, `git add -A`, and `npm publish`.
- Settings rollback depends on the store honoring `update(key, undefined)` as an unset operation.

## Related Docs

- `spec.md`
- `workspace-guard-spec-v0.2.md`

© 2026 ToppyMicroServices OÜ — Registry code 16551297 — Tallinn, Estonia.
