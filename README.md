# HomeGuard

![HomeGuard icon](./assets/homeguard-icon.svg)

HomeGuard is a TypeScript library and CLI for reducing the risk of opening your entire home directory in VS Code. It provides:

- Path-risk evaluation for home and high-risk folders
- A `homeguard-code` wrapper around the `code` CLI
- Extension-host helpers for workspace detection and guarded actions
- Telemetry hardening helpers with rollback support

## Project Layout

- `src/core/pathPolicy.ts`: path expansion, normalization, `realpath`, and risk classification
- `src/core/escapeFolder.ts`: escape-folder resolution and initialization
- `src/cli/homeguardCode.ts`: CLI planning and `code` process execution
- `src/extension/homeguardExtension.ts`: workspace detection and activation flow
- `src/extension/workspaceSafetyGuard.ts`: action-level guards for save/git/terminal/task/publish
- `src/core/telemetry.ts`: telemetry audit and hardening profile
- `src/core/settingsBackup.ts`: settings backup and rollback

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Test

```bash
npm test
```

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

## Library Entry Points

The package re-exports the main APIs from `src/index.ts`.

Useful entry points:

- `evaluatePathRisk`
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
- The project currently ships code and tests but no published VS Code extension package manifest.

## Related Docs

- `spec.md`
- `workspace-guard-spec-v0.2.md`
